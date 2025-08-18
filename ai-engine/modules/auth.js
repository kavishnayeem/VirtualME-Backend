import { google } from "googleapis";
import jwt from "jsonwebtoken";

export class AuthService {
  constructor() {
    this.oauth2Client = null;
    this.jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
    this.googleClientId = process.env.GOOGLE_CLIENT_ID;
    this.googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    this.redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4001/auth/google/callback';
    
    this.initializeOAuth();
  }

  initializeOAuth() {
    if (this.googleClientId && this.googleClientSecret) {
      this.oauth2Client = new google.auth.OAuth2(
        this.googleClientId,
        this.googleClientSecret,
        this.redirectUri
      );
    }
  }

  getAuthUrl(userId, scopes = []) {
    if (!this.oauth2Client) {
      throw new Error('OAuth client not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    }

    const defaultScopes = [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/photoslibrary.readonly',
      'https://www.googleapis.com/auth/user.addresses.read'
    ];

    const allScopes = [...new Set([...defaultScopes, ...scopes])];

    const authUrl = this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: allScopes,
      state: userId,
      prompt: 'consent'
    });

    return authUrl;
  }

  async exchangeCodeForTokens(code) {
    if (!this.oauth2Client) {
      throw new Error('OAuth client not configured');
    }

    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      this.oauth2Client.setCredentials(tokens);
      return tokens;
    } catch (error) {
      console.error('Token exchange error:', error);
      throw error;
    }
  }

  async refreshAccessToken(refreshToken) {
    if (!this.oauth2Client) {
      throw new Error('OAuth client not configured');
    }

    try {
      this.oauth2Client.setCredentials({
        refresh_token: refreshToken
      });

      const { credentials } = await this.oauth2Client.refreshAccessToken();
      return credentials;
    } catch (error) {
      console.error('Token refresh error:', error);
      throw error;
    }
  }

  setTokens(tokens) {
    if (!this.oauth2Client) {
      throw new Error('OAuth client not configured');
    }
    
    this.oauth2Client.setCredentials(tokens);
  }

  getOAuthClient() {
    return this.oauth2Client;
  }

  generateJWT(payload) {
    return jwt.sign(payload, this.jwtSecret, { expiresIn: '24h' });
  }

  verifyJWT(token) {
    try {
      return jwt.verify(token, this.jwtSecret);
    } catch (error) {
      throw new Error('Invalid token');
    }
  }

  async getUserInfo() {
    if (!this.oauth2Client) {
      throw new Error('OAuth client not configured');
    }

    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: this.oauth2Client });
      const { data } = await oauth2.userinfo.get();
      return data;
    } catch (error) {
      console.error('User info error:', error);
      throw error;
    }
  }

  middleware() {
    return (req, res, next) => {
      const token = req.headers.authorization?.split(' ')[1];
      
      if (!token) {
        return res.status(401).json({ error: 'No token provided' });
      }

      try {
        const decoded = this.verifyJWT(token);
        req.user = decoded;
        next();
      } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    };
  }

  async validateGoogleTokens(tokens) {
    if (!tokens.access_token) {
      return false;
    }

    try {
      this.setTokens(tokens);
      await this.getUserInfo();
      return true;
    } catch (error) {
      return false;
    }
  }
}