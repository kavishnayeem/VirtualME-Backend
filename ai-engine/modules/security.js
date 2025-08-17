import crypto from "crypto";
import bcrypt from "bcryptjs";

export class SecurityService {
  constructor() {
    this.encryptionKey = process.env.ENCRYPTION_KEY || this.generateKey();
    this.algorithm = 'aes-256-gcm';
  }

  generateKey() {
    return crypto.randomBytes(32).toString('hex');
  }

  encrypt(text) {
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipher(this.algorithm, this.encryptionKey);
      cipher.setAAD(Buffer.from('ai-engine-data'));
      
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const authTag = cipher.getAuthTag();
      
      return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
      };
    } catch (error) {
      console.error('Encryption error:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  decrypt(encryptedData) {
    try {
      const { encrypted, iv, authTag } = encryptedData;
      const decipher = crypto.createDecipher(this.algorithm, this.encryptionKey);
      
      decipher.setAAD(Buffer.from('ai-engine-data'));
      decipher.setAuthTag(Buffer.from(authTag, 'hex'));
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      console.error('Decryption error:', error);
      throw new Error('Failed to decrypt data');
    }
  }

  hashPassword(password) {
    return bcrypt.hashSync(password, 12);
  }

  verifyPassword(password, hash) {
    return bcrypt.compareSync(password, hash);
  }

  sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    
    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '')
      .trim();
  }

  validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  validateUserId(userId) {
    if (!userId || typeof userId !== 'string') return false;
    return /^[a-zA-Z0-9_-]+$/.test(userId) && userId.length >= 3 && userId.length <= 50;
  }

  generateSecureToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  rateLimit(requests, windowMs = 900000, maxRequests = 100) {
    const now = Date.now();
    const windowStart = now - windowMs;
    
    const recentRequests = requests.filter(timestamp => timestamp > windowStart);
    
    if (recentRequests.length >= maxRequests) {
      return false;
    }
    
    requests.push(now);
    return true;
  }

  createRateLimitMiddleware(maxRequests = 100, windowMs = 900000) {
    const requestLog = new Map();
    
    return (req, res, next) => {
      const clientId = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      
      if (!requestLog.has(clientId)) {
        requestLog.set(clientId, []);
      }
      
      const requests = requestLog.get(clientId);
      
      if (!this.rateLimit(requests, windowMs, maxRequests)) {
        return res.status(429).json({
          error: 'Too many requests',
          retryAfter: Math.ceil(windowMs / 1000)
        });
      }
      
      next();
    };
  }

  validateDataIngestionPayload(payload) {
    const errors = [];
    
    if (!payload.dataType || typeof payload.dataType !== 'string') {
      errors.push('Invalid or missing dataType');
    }
    
    if (payload.dataType && !['gmail', 'calendar', 'drive', 'location', 'third-party'].includes(payload.dataType)) {
      errors.push('Unsupported dataType');
    }
    
    if (payload.options && typeof payload.options !== 'object') {
      errors.push('Invalid options format');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }

  validateChatPayload(payload) {
    const errors = [];
    
    if (!payload.message || typeof payload.message !== 'string') {
      errors.push('Invalid or missing message');
    }
    
    if (payload.message && payload.message.length > 10000) {
      errors.push('Message too long (max 10000 characters)');
    }
    
    if (payload.includeContext !== undefined && typeof payload.includeContext !== 'boolean') {
      errors.push('Invalid includeContext parameter');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }

  obfuscatePersonalData(data) {
    if (!data || typeof data !== 'object') return data;
    
    const obfuscated = { ...data };
    
    const sensitiveFields = ['email', 'phone', 'address', 'ssn', 'creditCard'];
    
    sensitiveFields.forEach(field => {
      if (obfuscated[field]) {
        const value = obfuscated[field].toString();
        if (value.length > 4) {
          obfuscated[field] = value.substring(0, 2) + '*'.repeat(value.length - 4) + value.substring(value.length - 2);
        } else {
          obfuscated[field] = '*'.repeat(value.length);
        }
      }
    });
    
    return obfuscated;
  }

  logSecurityEvent(eventType, details, userId = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      eventType,
      userId,
      details: this.obfuscatePersonalData(details),
      severity: this.getEventSeverity(eventType)
    };
    
    console.log('Security Event:', JSON.stringify(logEntry, null, 2));
    
    if (logEntry.severity === 'high') {
      console.warn('HIGH SEVERITY SECURITY EVENT:', logEntry);
    }
  }

  getEventSeverity(eventType) {
    const highSeverityEvents = [
      'unauthorized_access',
      'token_tampering',
      'data_breach_attempt',
      'suspicious_activity'
    ];
    
    const mediumSeverityEvents = [
      'failed_authentication',
      'rate_limit_exceeded',
      'invalid_request'
    ];
    
    if (highSeverityEvents.includes(eventType)) return 'high';
    if (mediumSeverityEvents.includes(eventType)) return 'medium';
    return 'low';
  }

  createSecurityHeaders() {
    return (req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
      next();
    };
  }
}