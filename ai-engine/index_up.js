import express from "express";
import cors from "cors";
import dotenv from "dotenv";
// Groq AI integration is handled in AICloneService
import { google } from "googleapis";
import { DataIngestionService } from "./modules/dataIngestion.js";
import { AuthService } from "./modules/auth.js";
import { UserProfileService } from "./modules/userProfile.js";
import { AICloneService } from "./modules/aiClone.js";
import { SecurityService } from "./modules/security.js";
import { ResponseWrapper, ValidationError, UnauthorizedError, NotFoundError } from "./modules/responseWrapper.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(cors({ origin: "*" }));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const isVercel = process.env.VERCEL === "1";

if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY environment variable");
}

const authService = new AuthService();
const userProfileService = new UserProfileService();
const dataIngestionService = new DataIngestionService(authService, userProfileService);
const aiCloneService = new AICloneService(GROQ_API_KEY);
const securityService = new SecurityService();

// Helper functions (moved to userProfileService)

app.use(securityService.createSecurityHeaders());
app.use(securityService.createRateLimitMiddleware());
app.use(ResponseWrapper.middleware());

app.get('/', (req, res) => {
  res.apiSuccess({
    service: 'VirtualME AI Engine',
    version: '1.0.0',
    status: 'operational',
    endpoints: {
      auth: {
        'GET /v1/auth/google/:userId': 'Start Google OAuth flow',
        'GET /v1/auth/google/callback': 'Handle OAuth redirect',
        'POST /v1/auth/callback': 'Handle OAuth callback (API)'
      },
      data: {
        'POST /v1/ingest': 'Ingest user data from various sources',
        'GET /v1/profile/:userId': 'Retrieve user profile and data'
      },
      ai: {
        'POST /v1/chat': 'Chat with AI clone',
        'POST /v1/train': 'Train AI with conversation data'
      },
      system: {
        'GET /v1/health': 'System health check',
        'POST /v1/test/chat': 'Test chat (development only)'
      }
    },
    documentation: 'https://docs.virtualme.ai/api'
  }, 'VirtualME AI Engine API');
});

// API Versioning
const v1Router = express.Router();

// Health check (unversioned)
app.get('/health', (req, res) => {
  const healthData = {
    status: 'healthy',
    services: {
      groq: {
        status: !!GROQ_API_KEY ? 'connected' : 'not_configured',
        configured: !!GROQ_API_KEY
      },
      oauth: {
        status: !!authService.oauth2Client ? 'configured' : 'not_configured',
        configured: !!authService.oauth2Client
      },
      database: {
        status: 'memory', // Will update when we add database
        configured: true
      }
    },
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
    }
  };
  
  res.apiSuccess(healthData, 'System health check completed');
});

// Apply versioned routes
app.use('/v1', v1Router);

// Legacy OAuth callback route (for Google OAuth redirect)
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state: userId, error: oauthError } = req.query;
    
    if (oauthError) {
      return res.apiError(
        `OAuth authentication failed: ${oauthError}`,
        'OAUTH_ERROR',
        400,
        { oauthError, userId }
      );
    }
    
    if (!code || !userId) {
      throw new ValidationError(
        'Missing required OAuth parameters',
        { missingFields: !code ? ['code'] : ['userId'] }
      );
    }

    console.log("Processing OAuth callback for user:", userId);
    console.log("Authorization code received:", code.substring(0, 20) + "...");

    const tokens = await authService.exchangeCodeForTokens(code);
    console.log("Tokens received:", Object.keys(tokens));
    
    dataIngestionService.setOAuthClient(authService.getOAuthClient());

    // Create or update profile (handles existing users)
    const profileResult = await userProfileService.createProfile(userId);
    const isExistingUser = profileResult.isExistingUser;

    const userInfo = await authService.getUserInfo();
    console.log("User info:", userInfo.name, userInfo.email);
    console.log("Is existing user:", isExistingUser);
    
    // Store OAuth tokens in user profile
    console.log("Storing OAuth tokens for user:", userId, "Tokens keys:", Object.keys(tokens));
    await userProfileService.storeOAuthTokens(userId, tokens);
    console.log("OAuth tokens stored successfully");
    
    // Update profile with latest user info
    await userProfileService.updateProfile(userId, {
      personalInfo: {
        name: userInfo.name,
        email: userInfo.email,
        picture: userInfo.picture
      }
    });

    // Auto-ingest calendar data after successful OAuth
    try {
      console.log("Auto-ingesting calendar data for user:", userId);
      const calendarResult = await dataIngestionService.ingestCalendarData(userId, {});
      const analysisResult = await userProfileService.analyzeCalendarPatterns(userId, calendarResult.data);
      
      // Store calendar data in user profile
      await userProfileService.updateProfile(userId, {
        context: {
          recentCalendarEvents: calendarResult.data,
          lastCalendarSync: calendarResult.timestamp,
          calendarSummary: {
            totalEvents: calendarResult.count,
            upcomingEvents: calendarResult.summary?.upcoming || 0,
            todayEvents: calendarResult.summary?.today || 0
          }
        },
        dataHistory: {
          lastIngested: { calendar: calendarResult.timestamp },
          sources: ['calendar'],
          totalDataPoints: calendarResult.count || 0
        }
      });
      console.log(`Auto-ingested ${calendarResult.count} calendar events for user ${userId}`);
    } catch (calendarError) {
      console.log("Calendar auto-ingestion failed:", calendarError.message);
      // Don't fail OAuth if calendar ingestion fails
    }

    // Auto-ingest location data
    try {
      console.log("Auto-ingesting location data for user:", userId);
      const locationResult = await dataIngestionService.ingestLocationData(userId, {});
      
      // Store location data in user profile
      await userProfileService.updateProfile(userId, {
        location: {
          timezone: locationResult.data.timezone,
          locale: locationResult.data.locale,
          addresses: locationResult.data.addresses,
          lastLocationSync: locationResult.timestamp
        }
      });
      console.log(`Auto-ingested location data for user ${userId}`);
    } catch (locationError) {
      console.log("Location auto-ingestion failed:", locationError.message);
      // Don't fail OAuth if location ingestion fails
    }

    const jwtToken = authService.generateJWT({ userId, email: userInfo.email });
    
    // Get profile statistics
    const profileStats = userProfileService.getProfileStatistics(userId);

    // Return standardized JSON response with user status
    const responseMessage = isExistingUser 
      ? 'Existing user re-authenticated successfully'
      : 'New user authentication completed successfully';
      
    const userStatus = isExistingUser ? 'existing_user_login' : 'new_user_registration';

    res.apiSuccess(
      {
        authentication: {
          token: jwtToken,
          type: 'Bearer',
          expiresIn: '24h'
        },
        user: {
          id: userId,
          name: userInfo.name,
          email: userInfo.email,
          picture: userInfo.picture,
          isExistingUser,
          accountAge: profileStats?.accountAge || 'New',
          lastLogin: profileStats?.lastLogin
        },
        profile: {
          dataSourcesConnected: profileStats?.dataSourcesConnected || 0,
          personalityTrained: profileStats?.personalityTrained || false,
          conversationHistory: profileStats?.conversationHistory || 0,
          profileCompleteness: profileStats?.profileCompleteness || 0,
          loginCount: profileStats?.loginCount || 1
        },
        permissions: {
          scopes: ['gmail.readonly', 'calendar.readonly', 'drive.readonly'],
          services: ['gmail', 'calendar', 'drive']
        }
      },
      responseMessage,
      {
        authenticationMethod: 'google_oauth',
        userStatus,
        profileCreated: !isExistingUser,
        profileUpdated: isExistingUser,
        tokensPersisted: true
      }
    );
  } catch (error) {
    console.error("Auth callback error:", error);
    
    if (error.name === 'ValidationError') {
      throw error; // Let error handler deal with it
    }
    
    res.apiError(
      'OAuth authentication failed',
      'OAUTH_CALLBACK_ERROR',
      500,
      { originalError: error.message }
    );
  }
});

// Legacy support (redirect to v1) - but handle auth carefully
app.use('/auth/google/:userId', (req, res, next) => {
  req.url = '/v1/auth/google/' + req.params.userId;
  v1Router.handle(req, res, next);
});

app.use('/ingest', (req, res, next) => {
  req.url = '/v1' + req.url;
  v1Router.handle(req, res, next);
});
app.use('/profile', (req, res, next) => {
  req.url = '/v1' + req.url;
  v1Router.handle(req, res, next);
});
app.use('/chat', (req, res, next) => {
  req.url = '/v1' + req.url;
  v1Router.handle(req, res, next);
});
app.use('/train', (req, res, next) => {
  req.url = '/v1' + req.url;
  v1Router.handle(req, res, next);
});
app.use('/test', (req, res, next) => {
  req.url = '/v1' + req.url;
  v1Router.handle(req, res, next);
});

// V1 API Routes
v1Router.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state: userId, error: oauthError } = req.query;
    
    if (oauthError) {
      return res.apiError(
        `OAuth authentication failed: ${oauthError}`,
        'OAUTH_ERROR',
        400,
        { oauthError, userId }
      );
    }
    
    if (!code || !userId) {
      throw new ValidationError(
        'Missing required OAuth parameters',
        { missingFields: !code ? ['code'] : ['userId'] }
      );
    }

    console.log("Processing OAuth callback for user:", userId);
    console.log("Authorization code received:", code.substring(0, 20) + "...");

    const tokens = await authService.exchangeCodeForTokens(code);
    console.log("Tokens received:", Object.keys(tokens));
    
    dataIngestionService.setOAuthClient(authService.getOAuthClient());

    // Create or update profile (handles existing users)
    const profileResult = await userProfileService.createProfile(userId);
    const isExistingUser = profileResult.isExistingUser;

    const userInfo = await authService.getUserInfo();
    console.log("User info:", userInfo.name, userInfo.email);
    console.log("Is existing user:", isExistingUser);
    
    // Store OAuth tokens in user profile
    await userProfileService.storeOAuthTokens(userId, tokens);
    
    // Update profile with latest user info
    await userProfileService.updateProfile(userId, {
      personalInfo: {
        name: userInfo.name,
        email: userInfo.email,
        picture: userInfo.picture
      }
    });

    const jwtToken = authService.generateJWT({ userId, email: userInfo.email });
    
    // Get profile statistics
    const profileStats = userProfileService.getProfileStatistics(userId);

    // Return standardized JSON response with user status
    const responseMessage = isExistingUser 
      ? 'Existing user re-authenticated successfully'
      : 'New user authentication completed successfully';
      
    const userStatus = isExistingUser ? 'existing_user_login' : 'new_user_registration';

    res.apiSuccess(
      {
        authentication: {
          token: jwtToken,
          type: 'Bearer',
          expiresIn: '24h'
        },
        user: {
          id: userId,
          name: userInfo.name,
          email: userInfo.email,
          picture: userInfo.picture,
          isExistingUser,
          accountAge: profileStats?.accountAge || 'New',
          lastLogin: profileStats?.lastLogin
        },
        profile: {
          dataSourcesConnected: profileStats?.dataSourcesConnected || 0,
          personalityTrained: profileStats?.personalityTrained || false,
          conversationHistory: profileStats?.conversationHistory || 0,
          profileCompleteness: profileStats?.profileCompleteness || 0,
          loginCount: profileStats?.loginCount || 1
        },
        permissions: {
          scopes: ['gmail.readonly', 'calendar.readonly', 'drive.readonly'],
          services: ['gmail', 'calendar', 'drive']
        }
      },
      responseMessage,
      {
        authenticationMethod: 'google_oauth',
        userStatus,
        profileCreated: !isExistingUser,
        profileUpdated: isExistingUser,
        tokensPersisted: true
      }
    );
  } catch (error) {
    console.error("Auth callback error:", error);
    
    if (error.name === 'ValidationError') {
      throw error; // Let error handler deal with it
    }
    
    res.apiError(
      'OAuth authentication failed',
      'OAUTH_CALLBACK_ERROR',
      500,
      { originalError: error.message }
    );
  }
});

v1Router.get("/auth/google/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!userId || userId.length < 3) {
      throw new ValidationError(
        'Invalid user ID provided',
        { userId, requirements: 'User ID must be at least 3 characters long' }
      );
    }
    
    const authUrl = authService.getAuthUrl(userId);
    
    res.apiSuccess(
      {
        authUrl,
        userId,
        instructions: {
          step1: 'Visit the authUrl in your browser',
          step2: 'Complete Google OAuth authorization',
          step3: 'You will be redirected back with your authentication token'
        },
        scopes: {
          gmail: 'Read-only access to Gmail messages',
          calendar: 'Read-only access to calendar events',
          drive: 'Read-only access to Drive files',
          profile: 'Basic profile information'
        }
      },
      'OAuth URL generated successfully',
      { flow: 'google_oauth_initiation' }
    );
  } catch (error) {
    console.error("Auth URL error:", error);
    
    if (error.name === 'ValidationError') {
      throw error;
    }
    
    res.apiError(
      'Failed to generate OAuth URL',
      'AUTH_URL_GENERATION_ERROR',
      500,
      { originalError: error.message }
    );
  }
});

// Keep the POST endpoint for programmatic access
v1Router.post("/auth/callback", async (req, res) => {
  try {
    const { code, state: userId } = req.body;
    
    if (!code || !userId) {
      throw new ValidationError(
        'Missing required OAuth parameters',
        { missingFields: !code ? ['code'] : ['userId'] }
      );
    }

    const tokens = await authService.exchangeCodeForTokens(code);
    dataIngestionService.setOAuthClient(authService.getOAuthClient());

    // Create or update profile (handles existing users)
    const profileResult = await userProfileService.createProfile(userId);
    const isExistingUser = profileResult.isExistingUser;

    const userInfo = await authService.getUserInfo();
    
    // Store OAuth tokens in user profile
    await userProfileService.storeOAuthTokens(userId, tokens);
    
    await userProfileService.updateProfile(userId, {
      personalInfo: {
        name: userInfo.name,
        email: userInfo.email,
        picture: userInfo.picture
      }
    });

    const jwtToken = authService.generateJWT({ userId, email: userInfo.email });
    const profileStats = userProfileService.getProfileStatistics(userId);

    res.apiSuccess(
      {
        authentication: {
          token: jwtToken,
          type: 'Bearer',
          expiresIn: '24h'
        },
        user: {
          id: userId,
          name: userInfo.name,
          email: userInfo.email,
          picture: userInfo.picture,
          isExistingUser,
          accountAge: profileStats?.accountAge || 'New'
        },
        profile: {
          dataSourcesConnected: profileStats?.dataSourcesConnected || 0,
          profileCompleteness: profileStats?.profileCompleteness || 0,
          loginCount: profileStats?.loginCount || 1
        }
      },
      isExistingUser 
        ? 'Existing user re-authenticated successfully (API)'
        : 'New user authentication completed successfully (API)',
      { 
        authenticationMethod: 'google_oauth_api',
        userStatus: isExistingUser ? 'existing_user_login' : 'new_user_registration'
      }
    );
  } catch (error) {
    console.error("Auth callback error:", error);
    
    if (error.name === 'ValidationError') {
      throw error;
    }
    
    res.apiError(
      'OAuth authentication failed',
      'OAUTH_API_CALLBACK_ERROR',
      500,
      { originalError: error.message }
    );
  }
});

v1Router.post("/ingest", authService.middleware(), async (req, res) => {
  try {
    const { dataType, options = {} } = req.body;
    const userId = req.user.userId;
    
    // Validate input
    const validation = securityService.validateDataIngestionPayload({ dataType, options });
    if (!validation.isValid) {
      throw new ValidationError(
        'Invalid data ingestion request',
        { validationErrors: validation.errors }
      );
    }

    let result;
    let analysisResult = null;
    
    switch (dataType) {
      case 'calendar':
        result = await dataIngestionService.ingestCalendarData(userId, options);
        analysisResult = await userProfileService.analyzeCalendarPatterns(userId, result.data);
        // Store calendar data in user profile
        await userProfileService.updateProfile(userId, {
          context: {
            recentCalendarEvents: result.data,
            lastCalendarSync: result.timestamp,
            calendarSummary: {
              totalEvents: result.count,
              upcomingEvents: result.summary?.upcoming || 0,
              todayEvents: result.summary?.today || 0
            }
          },
          dataHistory: {
            lastIngested: { [dataType]: result.timestamp },
            sources: [dataType],
            totalDataPoints: (result.count || 0)
          }
        });
        break;
      case 'third-party':
        if (!options.service) {
          throw new ValidationError('Missing service parameter for third-party data');
        }
        result = await dataIngestionService.ingestThirdPartyData(userId, options.service, options.data);
        break;
      default:
        throw new ValidationError(
          'Unsupported data type',
          { supportedTypes: ['calendar', 'third-party'] }
        );
    }

    res.apiSuccess(
      {
        ingestion: {
          service: result.service,
          dataType: result.dataType,
          itemsProcessed: result.count,
          timestamp: result.timestamp
        },
        analysis: analysisResult,
        summary: {
          totalItems: result.count,
          processingTime: new Date() - new Date(result.timestamp),
          dataStored: dataType === 'calendar' // Will expand based on storage logic
        }
      },
      `Successfully ingested ${result.count} ${dataType} items`,
      {
        dataSource: dataType,
        userId,
        profileUpdated: !!analysisResult
      }
    );
  } catch (error) {
    console.error("Ingest error:", error);
    
    if (error.name === 'ValidationError') {
      throw error;
    }
    
    res.apiError(
      'Data ingestion failed',
      'DATA_INGESTION_ERROR',
      500,
      { 
        dataType: req.body.dataType,
        originalError: error.message 
      }
    );
  }
});

v1Router.get("/profile/:userId", authService.middleware(), async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (req.user.userId !== userId) {
      throw new ForbiddenError(
        'Access denied: You can only access your own profile'
      );
    }

    const profile = await userProfileService.getProfile(userId);
    
    if (!profile) {
      throw new NotFoundError(
        'User profile not found',
        { userId }
      );
    }

    // Remove sensitive data before sending
    const sanitizedProfile = {
      ...profile,
      oauth: undefined // Don't expose OAuth tokens
    };

    res.apiSuccess(
      {
        profile: sanitizedProfile,
        statistics: {
          dataSourcesConnected: profile.dataHistory?.sources?.length || 0,
          lastActivity: profile.updatedAt,
          totalDataPoints: profile.dataHistory?.totalDataPoints || 0,
          profileCompleteness: profile.profileCompleteness || userProfileService.calculateProfileCompleteness(profile)
        }
      },
      'Profile retrieved successfully',
      {
        userId,
        profileVersion: profile.updatedAt
      }
    );
  } catch (error) {
    console.error("Profile error:", error);
    
    if (['ValidationError', 'ForbiddenError', 'NotFoundError'].includes(error.name)) {
      throw error;
    }
    
    res.apiError(
      'Profile retrieval failed',
      'PROFILE_RETRIEVAL_ERROR',
      500,
      { userId: req.params.userId }
    );
  }
});

v1Router.post("/chat", authService.middleware(), async (req, res) => {
  try {
    const { message, includeContext = true } = req.body;
    const userId = req.user.userId;
    
    // Validate input
    const validation = securityService.validateChatPayload({ message, includeContext });
    if (!validation.isValid) {
      throw new ValidationError(
        'Invalid chat request',
        { validationErrors: validation.errors }
      );
    }

    let context = {};
    let contextInfo = {
      personalityUsed: false,
      calendarEventsCount: 0,
      emailsCount: 0,
      filesCount: 0,
      profileDataUsed: false,
      dataSourcesUsed: []
    };
    
    if (includeContext) {
      const profile = await userProfileService.getProfile(userId);
      console.log("DEBUG - Chat context check for user:", userId, "Profile found:", !!profile);
      if (profile) {
        console.log("DEBUG - Profile personalInfo:", profile.personalInfo);
        context.personalityPrompt = userProfileService.generatePersonalityPrompt(userId);
        context.userProfile = profile;
        contextInfo.personalityUsed = true;
        contextInfo.profileDataUsed = true;
        
        let additionalContextParts = [];
        
        // Add recent calendar events to context
        if (profile.context?.recentCalendarEvents?.length > 0) {
          const events = profile.context.recentCalendarEvents;
          const now = new Date();
          const today = now.toDateString();
          
          const eventDetails = events.map(event => {
            const timeRange = event.endTime ? `${event.startTime} - ${event.endTime}` : event.startTime;
            const eventDate = new Date(event.start?.dateTime || event.start?.date);
            
            // Be explicit about actual dates to avoid confusion
            let dateLabel = event.dayLabel;
            if (event.date) {
              dateLabel = `${event.dayLabel} (${event.date})`;
            }
            
            return `${dateLabel}: "${event.summary}" at ${timeRange}`;
          }).join('; ');
          additionalContextParts.push(`Your calendar schedule: ${eventDetails}`);
          contextInfo.calendarEventsCount = events.length;
          contextInfo.dataSourcesUsed.push('calendar');
        }
        
        // Add location context
        if (profile.location) {
          let locationInfo = [];
          if (profile.location.timezone) {
            locationInfo.push(`Timezone: ${profile.location.timezone}`);
          }
          if (profile.location.addresses?.length > 0) {
            const primaryAddress = profile.location.addresses[0];
            if (primaryAddress.formattedValue) {
              locationInfo.push(`Location: ${primaryAddress.formattedValue}`);
            }
          }
          if (locationInfo.length > 0) {
            additionalContextParts.push(locationInfo.join(', '));
          }
        }

        // Add user activity summary
        if (profile.dataHistory?.sources?.length > 0) {
          const sources = profile.dataHistory.sources.join(', ');
          additionalContextParts.push(`Connected data sources: ${sources}`);
        }
        
        // Combine all context
        if (additionalContextParts.length > 0) {
          context.additionalContext = additionalContextParts.join('. ');
        }
      }
    }

    const result = await aiCloneService.generateResponse(userId, message, context);

    res.apiSuccess(
      {
        conversation: {
          message: result.response,
          userId: result.userId,
          timestamp: result.timestamp
        },
        context: {
          used: includeContext,
          ...contextInfo,
          promptType: result.context?.promptUsed || 'default',
          totalDataSources: contextInfo.dataSourcesUsed.length,
          dataSources: contextInfo.dataSourcesUsed
        },
        metadata: {
          hasConversationHistory: result.context?.hasHistory || false,
          responseGenerated: true
        }
      },
      'AI response generated successfully',
      {
        conversationId: result.userId,
        responseLength: result.response?.length || 0
      }
    );
  } catch (error) {
    console.error("Chat error:", error);
    
    if (error.name === 'ValidationError') {
      throw error;
    }
    
    res.apiError(
      'Chat processing failed',
      'CHAT_PROCESSING_ERROR',
      500,
      { originalError: error.message }
    );
  }
});

v1Router.post("/train", authService.middleware(), async (req, res) => {
  try {
    const { conversationData } = req.body;
    const userId = req.user.userId;
    
    if (!conversationData || !Array.isArray(conversationData)) {
      throw new ValidationError(
        'Invalid conversation data',
        { 
          expected: 'Array of conversation objects',
          received: typeof conversationData 
        }
      );
    }

    if (conversationData.length === 0) {
      throw new ValidationError('Conversation data cannot be empty');
    }

    const result = await aiCloneService.trainFromConversation(userId, conversationData);

    res.apiSuccess(
      {
        training: {
          conversationsProcessed: conversationData.length,
          suggestions: result.trainingSuggestions,
          analysis: result.conversationAnalysis,
          timestamp: result.timestamp
        },
        improvements: {
          personalityAdjustments: result.trainingSuggestions?.adjustments?.length || 0,
          newTraits: result.trainingSuggestions?.newTraits?.length || 0,
          styleImprovements: result.trainingSuggestions?.styleImprovements?.length || 0
        }
      },
      'AI training completed successfully',
      {
        userId,
        trainingDataSize: conversationData.length
      }
    );
  } catch (error) {
    console.error("Training error:", error);
    
    if (error.name === 'ValidationError') {
      throw error;
    }
    
    res.apiError(
      'AI training failed',
      'TRAINING_ERROR',
      500,
      { originalError: error.message }
    );
  }
});


// Test endpoint for development (bypasses auth)
v1Router.post("/test/chat", async (req, res) => {
  try {
    const { message, userId = "testuser123" } = req.body;
    
    if (!message) {
      throw new ValidationError('Missing message parameter for test chat');
    }

    // Create a test profile with sample calendar data
    await userProfileService.createProfile(userId, {
      personalInfo: {
        name: "Farazuddin Mohammed",
        email: "farazuddinmohammed05@gmail.com"
      }
    });

    // Update profile with sample calendar data
    await userProfileService.updateProfile(userId, {
      context: {
        recentCalendarEvents: [
          {
            summary: "Team Standup",
            dayLabel: "Today", 
            startTime: "9:00 AM",
            endTime: "9:30 AM"
          },
          {
            summary: "Project Review",
            dayLabel: "Today",
            startTime: "2:00 PM", 
            endTime: "3:00 PM"
          },
          {
            summary: "Client Meeting",
            dayLabel: "Tomorrow",
            startTime: "10:00 AM",
            endTime: "11:00 AM"
          }
        ]
      }
    });

    // Get context the same way as the real chat endpoint
    const profile = await userProfileService.getProfile(userId);
    let context = {};
    let additionalContextParts = [];
    
    if (profile?.context?.recentCalendarEvents?.length > 0) {
      const events = profile.context.recentCalendarEvents;
      const eventDetails = events.map(event => {
        const timeRange = event.endTime ? `${event.startTime} - ${event.endTime}` : event.startTime;
        return `${event.dayLabel}: "${event.summary}" at ${timeRange}`;
      }).join('; ');
      additionalContextParts.push(`Your schedule: ${eventDetails}`);
    }
    
    if (additionalContextParts.length > 0) {
      context.additionalContext = additionalContextParts.join('. ');
    }
    
    context.personalityPrompt = userProfileService.generatePersonalityPrompt(userId);

    const result = await aiCloneService.generateResponse(userId, message, context);

    res.apiSuccess(
      {
        conversation: {
          message: result.response,
          userId: result.userId,
          timestamp: result.timestamp
        },
        testing: {
          mode: 'development',
          authBypass: true,
          testProfile: true
        }
      },
      'Test chat completed successfully',
      {
        endpoint: 'test_chat',
        userId
      }
    );
  } catch (error) {
    console.error("Test chat error:", error);
    
    if (error.name === 'ValidationError') {
      throw error;
    }
    
    res.apiError(
      'Test chat failed',
      'TEST_CHAT_ERROR',
      500,
      { originalError: error.message }
    );
  }
});

// Add global error handler
app.use(ResponseWrapper.errorHandler());

if (!isVercel) {
  const PORT = process.env.PORT || 4001;
  app.listen(PORT, () => {
    console.log(`AI Engine server running on port ${PORT}`);
  });
}

export default app;