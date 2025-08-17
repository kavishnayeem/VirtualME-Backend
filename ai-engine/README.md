# AI Engine - Virtual Clone Backend

A comprehensive AI-powered backend service that creates virtual clones of users by ingesting their personal data from Google Services and third-party sources, then using Gemini AI to simulate their personality and communication style.

## Features

- **Google Services Integration**: Ingest data from Gmail, Calendar, Drive, Photos, and more
- **AI-Powered Personality Modeling**: Uses Gemini AI to learn and replicate user communication patterns
- **Secure Authentication**: OAuth 2.0 integration with Google services and JWT-based API authentication
- **Privacy-First Design**: Data encryption, sanitization, and comprehensive security controls
- **Real-time Chat**: Interactive chat interface with the user's AI clone
- **Continuous Learning**: The AI clone improves over time with more data and interactions

## API Endpoints

### Authentication
- `GET /auth/google/:userId` - Start Google OAuth flow
- `POST /auth/callback` - Handle OAuth callback and exchange tokens

### Data Management
- `POST /ingest` - Ingest user data from various sources
- `GET /profile/:userId` - Retrieve user profile and personality data
- `POST /train` - Train the AI clone with conversation data

### AI Interaction
- `POST /chat` - Chat with the AI clone
- `GET /health` - Service health check

## Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Environment Configuration**
   Copy `.env.example` to `.env` and configure:
   ```
   GEMINI_API_KEY=your_gemini_api_key
   GOOGLE_CLIENT_ID=your_google_client_id
   GOOGLE_CLIENT_SECRET=your_google_client_secret
   JWT_SECRET=your_jwt_secret
   ```

3. **Google OAuth Setup**
   - Create a project in Google Cloud Console
   - Enable Gmail, Calendar, and Drive APIs
   - Create OAuth 2.0 credentials
   - Add your domain to authorized origins

4. **Start the Server**
   ```bash
   npm start
   ```

## Architecture

### Core Modules

- **DataIngestionService**: Handles data collection from Google services and third-party sources
- **AuthService**: Manages OAuth authentication and JWT token generation
- **UserProfileService**: Analyzes user data to build personality profiles
- **AICloneService**: Generates responses using Gemini AI with personalized context
- **SecurityService**: Provides encryption, rate limiting, and security controls

### Data Flow

1. **Authentication**: User authenticates via Google OAuth
2. **Data Ingestion**: System collects data from authorized services
3. **Profile Building**: AI analyzes patterns to build personality model
4. **Clone Interaction**: Users chat with their AI clone
5. **Continuous Learning**: System improves based on interactions

## Security Features

- **Data Encryption**: All sensitive data encrypted at rest
- **Rate Limiting**: Protection against abuse and DoS attacks
- **Input Sanitization**: Prevents XSS and injection attacks
- **Secure Headers**: Implements security best practices
- **OAuth Scopes**: Minimal required permissions
- **Audit Logging**: Comprehensive security event logging

## Deployment

### Vercel Deployment

1. **Set Environment Variables** in Vercel dashboard
2. **Deploy**: 
   ```bash
   vercel --prod
   ```

### Local Development

```bash
npm run dev
```

## Privacy & Compliance

- **Data Minimization**: Only collects necessary data
- **User Consent**: Explicit permission for each data source
- **Data Retention**: Configurable retention policies
- **Right to Deletion**: Users can delete their data
- **Anonymization**: Personal data obfuscation in logs

## Usage Examples

### Start Authentication
```javascript
GET /auth/google/user123
// Returns: { authUrl: "https://accounts.google.com/oauth/authorize?..." }
```

### Ingest Gmail Data
```javascript
POST /ingest
Authorization: Bearer jwt_token
{
  "dataType": "gmail",
  "options": { "maxResults": 50 }
}
```

### Chat with AI Clone
```javascript
POST /chat
Authorization: Bearer jwt_token
{
  "message": "What are my upcoming meetings?",
  "includeContext": true
}
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Implement changes with tests
4. Submit a pull request

## License

MIT License - see LICENSE file for details