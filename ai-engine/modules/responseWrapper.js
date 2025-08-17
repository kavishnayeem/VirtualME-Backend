import crypto from 'crypto';

export class ResponseWrapper {
  static success(data, message = 'Success', metadata = {}) {
    return {
      success: true,
      message,
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        requestId: crypto.randomUUID(),
        version: '1.0',
        ...metadata
      },
      error: null
    };
  }

  static error(message, errorCode = 'UNKNOWN_ERROR', statusCode = 500, details = null) {
    return {
      success: false,
      message,
      data: null,
      metadata: {
        timestamp: new Date().toISOString(),
        requestId: crypto.randomUUID(),
        version: '1.0'
      },
      error: {
        code: errorCode,
        statusCode,
        details
      }
    };
  }

  static paginated(data, pagination, message = 'Success') {
    return {
      success: true,
      message,
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        requestId: crypto.randomUUID(),
        version: '1.0',
        pagination: {
          page: pagination.page || 1,
          limit: pagination.limit || 50,
          total: pagination.total || data.length,
          totalPages: Math.ceil((pagination.total || data.length) / (pagination.limit || 50)),
          hasNext: pagination.hasNext || false,
          hasPrev: pagination.hasPrev || false
        }
      },
      error: null
    };
  }

  static middleware() {
    return (req, res, next) => {
      // Add helper methods to response object
      res.apiSuccess = (data, message, metadata) => {
        return res.json(ResponseWrapper.success(data, message, metadata));
      };

      res.apiError = (message, errorCode, statusCode, details) => {
        const response = ResponseWrapper.error(message, errorCode, statusCode, details);
        return res.status(response.error.statusCode).json(response);
      };

      res.apiPaginated = (data, pagination, message) => {
        return res.json(ResponseWrapper.paginated(data, pagination, message));
      };

      next();
    };
  }

  static errorHandler() {
    return (error, req, res, next) => {
      console.error('API Error:', error);

      // Handle different types of errors
      let statusCode = 500;
      let errorCode = 'INTERNAL_SERVER_ERROR';
      let message = 'An internal server error occurred';
      let details = null;

      if (error.name === 'ValidationError') {
        statusCode = 400;
        errorCode = 'VALIDATION_ERROR';
        message = 'Request validation failed';
        details = error.details || error.message;
      } else if (error.name === 'UnauthorizedError' || error.message === 'Invalid token') {
        statusCode = 401;
        errorCode = 'UNAUTHORIZED';
        message = 'Authentication required';
      } else if (error.name === 'ForbiddenError') {
        statusCode = 403;
        errorCode = 'FORBIDDEN';
        message = 'Insufficient permissions';
      } else if (error.name === 'NotFoundError') {
        statusCode = 404;
        errorCode = 'NOT_FOUND';
        message = 'Resource not found';
      } else if (error.message === 'OAuth client not configured' || error.message.includes('OAuth')) {
        statusCode = 401;
        errorCode = 'OAUTH_ERROR';
        message = 'OAuth authentication failed';
        details = error.message;
      } else if (error.message.includes('rate limit')) {
        statusCode = 429;
        errorCode = 'RATE_LIMIT_EXCEEDED';
        message = 'Rate limit exceeded';
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        statusCode = 503;
        errorCode = 'SERVICE_UNAVAILABLE';
        message = 'External service unavailable';
      }

      // Log security events
      if (statusCode === 401 || statusCode === 403) {
        console.warn('Security Event:', {
          type: 'authentication_failure',
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          endpoint: req.path,
          timestamp: new Date().toISOString()
        });
      }

      const response = ResponseWrapper.error(message, errorCode, statusCode, details);
      res.status(statusCode).json(response);
    };
  }
}

// Common error classes for better error handling
export class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Not Found') {
    super(message);
    this.name = 'NotFoundError';
  }
}