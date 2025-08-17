import { google } from "googleapis";

export class DataIngestionService {
  constructor(authService = null, userProfileService = null) {
    this.oauth2Client = null;
    this.authService = authService;
    this.userProfileService = userProfileService;
    this.supportedServices = [
      'gmail',
      'calendar',
      'drive',
      'photos',
      'youtube',
      'contacts',
      'maps',
      'location'
    ];
  }

  setOAuthClient(oauth2Client) {
    this.oauth2Client = oauth2Client;
  }

  async ensureOAuthClient(userId) {
    if (this.oauth2Client) {
      console.log("OAuth client already exists, reusing");
      return this.oauth2Client;
    }

    if (!this.authService || !this.userProfileService) {
      throw new Error('AuthService and UserProfileService required for token retrieval');
    }

    // Try to get stored tokens
    console.log("Retrieving stored tokens for user:", userId);
    const tokens = await this.userProfileService.getOAuthTokens(userId);
    console.log("Retrieved tokens:", tokens ? "Found" : "Not found");
    
    if (!tokens) {
      throw new Error('No OAuth tokens found for user. Please re-authenticate.');
    }

    // Check if tokens are valid
    const isValid = await this.userProfileService.isTokenValid(userId);
    if (!isValid && tokens.refresh_token) {
      try {
        // Refresh the tokens
        const newTokens = await this.authService.refreshAccessToken(tokens.refresh_token);
        await this.userProfileService.storeOAuthTokens(userId, newTokens);
        this.oauth2Client = this.authService.getOAuthClient();
      } catch (error) {
        throw new Error('Failed to refresh OAuth tokens. Please re-authenticate.');
      }
    } else if (!isValid) {
      throw new Error('OAuth tokens expired and no refresh token available. Please re-authenticate.');
    } else {
      // Use stored tokens
      this.authService.setTokens(tokens);
      this.oauth2Client = this.authService.getOAuthClient();
    }

    return this.oauth2Client;
  }

  async ingestGmailData(userId, options = {}) {
    try {
      await this.ensureOAuthClient(userId);

      const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
      
      // Default to 1 year of emails, up to 500 emails max
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const defaultQuery = `after:${oneYearAgo.getFullYear()}/${String(oneYearAgo.getMonth() + 1).padStart(2, '0')}/${String(oneYearAgo.getDate()).padStart(2, '0')}`;
      
      const { maxResults = 500, query = defaultQuery } = options;

      const messages = await gmail.users.messages.list({
        userId: 'me',
        maxResults,
        q: query
      });

      const emailData = [];
      
      if (messages.data.messages) {
        // Process more emails, but limit to avoid timeout
        const emailsToProcess = Math.min(messages.data.messages.length, 100);
        for (const message of messages.data.messages.slice(0, emailsToProcess)) {
          const fullMessage = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full'
          });

          const headers = fullMessage.data.payload.headers;
          const subject = headers.find(h => h.name === 'Subject')?.value || '';
          const from = headers.find(h => h.name === 'From')?.value || '';
          const date = headers.find(h => h.name === 'Date')?.value || '';

          emailData.push({
            id: message.id,
            subject,
            from,
            date,
            snippet: fullMessage.data.snippet
          });
        }
      }

      return {
        service: 'gmail',
        userId,
        dataType: 'emails',
        count: emailData.length,
        data: emailData,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Gmail ingestion error:', error);
      throw error;
    }
  }

  async ingestCalendarData(userId, options = {}) {
    try {
      await this.ensureOAuthClient(userId);

      const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
      const { calendarId = 'primary' } = options;

      // Set time range: yesterday, today, tomorrow
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(23, 59, 59, 999);

      console.log(`Fetching calendar events from ${yesterday.toISOString()} to ${tomorrow.toISOString()}`);

      const events = await calendar.events.list({
        calendarId,
        timeMin: yesterday.toISOString(),
        timeMax: tomorrow.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      const calendarData = events.data.items?.map(event => {
        const startDate = event.start?.dateTime || event.start?.date;
        const endDate = event.end?.dateTime || event.end?.date;
        
        // Determine which day this event is on
        const eventDate = new Date(startDate);
        const todayDate = now.toDateString();
        const yesterdayDate = yesterday.toDateString();
        const tomorrowActualDate = new Date(now);
        tomorrowActualDate.setDate(tomorrowActualDate.getDate() + 1);
        const tomorrowDate = tomorrowActualDate.toDateString();
        
        let dayLabel = '';
        if (eventDate.toDateString() === yesterdayDate) {
          dayLabel = 'Yesterday';
        } else if (eventDate.toDateString() === todayDate) {
          dayLabel = 'Today';
        } else if (eventDate.toDateString() === tomorrowDate) {
          dayLabel = 'Tomorrow';
        }
        
        // Format time clearly
        const formatTime = (dateTime) => {
          if (!dateTime) return '';
          const date = new Date(dateTime);
          return date.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit',
            hour12: true 
          });
        };
        
        const formatDate = (dateTime) => {
          if (!dateTime) return '';
          const date = new Date(dateTime);
          return date.toLocaleDateString('en-US', { 
            weekday: 'long',
            month: 'long',
            day: 'numeric'
          });
        };
        
        return {
          id: event.id,
          summary: event.summary || 'Untitled Event',
          description: event.description || '',
          start: event.start,
          end: event.end,
          startTime: formatTime(startDate),
          endTime: formatTime(endDate),
          date: formatDate(startDate),
          dayLabel: dayLabel,
          attendees: event.attendees || [],
          location: event.location || '',
          creator: event.creator,
          organizer: event.organizer,
          status: event.status,
          htmlLink: event.htmlLink,
          recurringEventId: event.recurringEventId,
          metadata: {
            dayOfWeek: new Date(startDate).toLocaleDateString('en-US', { weekday: 'long' })
          }
        };
      }) || [];

      // Sort events by day: yesterday, today, tomorrow
      const sortedData = calendarData.sort((a, b) => {
        const order = { 'Yesterday': 1, 'Today': 2, 'Tomorrow': 3 };
        const aOrder = order[a.dayLabel] || 4;
        const bOrder = order[b.dayLabel] || 4;
        
        if (aOrder !== bOrder) {
          return aOrder - bOrder;
        }
        
        // Within same day, sort by time
        return new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date);
      });

      const summary = {
        total: sortedData.length,
        today: sortedData.filter(e => e.dayLabel === 'Today').length,
        tomorrow: sortedData.filter(e => e.dayLabel === 'Tomorrow').length,
        yesterday: sortedData.filter(e => e.dayLabel === 'Yesterday').length
      };

      return {
        service: 'calendar',
        userId,
        dataType: 'events',
        count: calendarData.length,
        data: sortedData,
        summary,
        dateRange: {
          from: yesterday.toISOString(),
          to: tomorrow.toISOString(),
          includedPastEvents: true,
          futureMonthsCovered: 1
        },
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Calendar ingestion error:', error);
      throw error;
    }
  }

  async ingestLocationData(userId, options = {}) {
    try {
      await this.ensureOAuthClient(userId);

      // Get user's profile information including location
      const oauth2 = google.oauth2({ version: 'v2', auth: this.oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      
      // Get user's addresses (requires user.addresses.read scope)
      const people = google.people({ version: 'v1', auth: this.oauth2Client });
      const profile = await people.people.get({
        resourceName: 'people/me',
        personFields: 'addresses,locations'
      });

      const locationData = {
        timezone: userInfo.data.timezone || null,
        locale: userInfo.data.locale || null,
        addresses: profile.data.addresses || [],
        // Note: Real-time location would require Google Location API
        // and additional permissions/setup
      };

      console.log(`Retrieved location data for user ${userId}`);

      return {
        service: 'location',
        userId,
        dataType: 'location',
        count: locationData.addresses.length,
        data: locationData,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Location ingestion error:', error);
      throw error;
    }
  }

  calculateEventDuration(startDate, endDate) {
    if (!startDate || !endDate) return null;
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffMs = end - start;
    
    if (diffMs >= 24 * 60 * 60 * 1000) {
      return Math.round(diffMs / (24 * 60 * 60 * 1000)) + ' days';
    } else {
      const hours = Math.floor(diffMs / (60 * 60 * 1000));
      const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
      return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }
  }

  async ingestDriveData(userId, options = {}) {
    try {
      await this.ensureOAuthClient(userId);

      const drive = google.drive({ version: 'v3', auth: this.oauth2Client });
      const { maxResults = 100, mimeType } = options;

      const files = await drive.files.list({
        pageSize: maxResults,
        fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, size)',
        q: mimeType ? `mimeType='${mimeType}'` : undefined
      });

      const driveData = files.data.files.map(file => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        createdTime: file.createdTime,
        modifiedTime: file.modifiedTime,
        size: file.size
      }));

      return {
        service: 'drive',
        userId,
        dataType: 'files',
        count: driveData.length,
        data: driveData,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Drive ingestion error:', error);
      throw error;
    }
  }

  async ingestThirdPartyData(userId, service, data) {
    try {
      const processedData = {
        service,
        userId,
        dataType: 'third-party',
        rawData: data,
        processed: this.processThirdPartyData(service, data),
        timestamp: new Date().toISOString()
      };

      return processedData;
    } catch (error) {
      console.error('Third-party ingestion error:', error);
      throw error;
    }
  }

  processThirdPartyData(service, data) {
    switch (service) {
      case 'fitness':
        return this.processFitnessData(data);
      case 'social':
        return this.processSocialData(data);
      case 'music':
        return this.processMusicData(data);
      default:
        return data;
    }
  }

  processFitnessData(data) {
    return {
      activities: data.activities || [],
      heartRate: data.heartRate || [],
      sleep: data.sleep || [],
      steps: data.steps || 0
    };
  }

  processSocialData(data) {
    return {
      posts: data.posts || [],
      interactions: data.interactions || [],
      connections: data.connections || []
    };
  }

  processMusicData(data) {
    return {
      playlists: data.playlists || [],
      recentTracks: data.recentTracks || [],
      preferences: data.preferences || {}
    };
  }

  getSupportedServices() {
    return this.supportedServices;
  }
}