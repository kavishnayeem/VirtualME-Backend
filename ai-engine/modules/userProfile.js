export class UserProfileService {
  constructor() {
    this.profiles = new Map();
  }

  async createProfile(userId, initialData = {}) {
    // Check if profile already exists
    const existingProfile = this.profiles.get(userId);
    if (existingProfile) {
      console.log(`Profile already exists for user ${userId}, updating instead of creating`);
      
      // Update existing profile with new data while preserving existing data
      const updatedProfile = this.deepMerge(existingProfile, {
        personalInfo: {
          name: initialData.name || existingProfile.personalInfo?.name || '',
          email: initialData.email || existingProfile.personalInfo?.email || '',
          timezone: initialData.timezone || existingProfile.personalInfo?.timezone || 'UTC',
          language: initialData.language || existingProfile.personalInfo?.language || 'en'
        },
        updatedAt: new Date().toISOString(),
        loginHistory: {
          lastLogin: new Date().toISOString(),
          loginCount: (existingProfile.loginHistory?.loginCount || 0) + 1
        }
      });
      
      this.profiles.set(userId, updatedProfile);
      return { ...updatedProfile, isExistingUser: true };
    }

    // Create new profile
    const profile = {
      userId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      personalInfo: {
        name: initialData.name || '',
        email: initialData.email || '',
        timezone: initialData.timezone || 'UTC',
        language: initialData.language || 'en'
      },
      preferences: {
        communicationStyle: 'neutral',
        responseLength: 'medium',
        formality: 'casual',
        humor: true,
        topics: []
      },
      patterns: {
        emailPatterns: {
          commonPhrases: [],
          responseTime: 'medium',
          tone: 'professional'
        },
        calendarPatterns: {
          meetingPreferences: {},
          workHours: { start: '09:00', end: '17:00' },
          busyDays: []
        },
        interactionPatterns: {
          frequentContacts: [],
          responseStyle: {},
          topics: {}
        }
      },
      personality: {
        traits: {},
        values: [],
        interests: [],
        expertise: []
      },
      context: {
        recentActivities: [],
        currentProjects: [],
        relationships: {},
        goals: []
      },
      dataHistory: {
        lastIngested: {},
        totalDataPoints: 0,
        sources: []
      },
      oauth: {
        googleTokens: null,
        tokenExpiry: null
      },
      loginHistory: {
        firstLogin: new Date().toISOString(),
        lastLogin: new Date().toISOString(),
        loginCount: 1
      }
    };

    this.profiles.set(userId, profile);
    return { ...profile, isExistingUser: false };
  }

  async getProfile(userId) {
    return this.profiles.get(userId) || null;
  }

  async updateProfile(userId, updates) {
    const profile = this.profiles.get(userId);
    if (!profile) {
      throw new Error('Profile not found');
    }

    // Special handling for data history merging
    if (updates.dataHistory) {
      const existingSources = profile.dataHistory?.sources || [];
      const newSources = updates.dataHistory.sources || [];
      const mergedSources = [...new Set([...existingSources, ...newSources])];
      
      updates.dataHistory.sources = mergedSources;
      
      // Merge lastIngested timestamps
      updates.dataHistory.lastIngested = {
        ...profile.dataHistory?.lastIngested,
        ...updates.dataHistory.lastIngested
      };
      
      // Add up total data points
      const existingPoints = profile.dataHistory?.totalDataPoints || 0;
      const newPoints = updates.dataHistory.totalDataPoints || 0;
      updates.dataHistory.totalDataPoints = existingPoints + newPoints;
    }

    const updatedProfile = this.deepMerge(profile, updates);
    updatedProfile.updatedAt = new Date().toISOString();
    
    this.profiles.set(userId, updatedProfile);
    return updatedProfile;
  }

  async analyzeEmailPatterns(userId, emailData) {
    const patterns = {
      commonPhrases: this.extractCommonPhrases(emailData),
      responseTime: this.analyzeResponseTime(emailData),
      tone: this.analyzeTone(emailData),
      subjects: this.analyzeSubjects(emailData),
      senders: this.analyzeSenders(emailData)
    };

    await this.updateProfile(userId, {
      patterns: { emailPatterns: patterns }
    });

    return patterns;
  }

  async analyzeCalendarPatterns(userId, calendarData) {
    const patterns = {
      meetingFrequency: this.analyzeMeetingFrequency(calendarData),
      workHours: this.analyzeWorkHours(calendarData),
      meetingTypes: this.analyzeMeetingTypes(calendarData),
      busyDays: this.analyzeBusyDays(calendarData)
    };

    await this.updateProfile(userId, {
      patterns: { calendarPatterns: patterns }
    });

    return patterns;
  }

  async analyzePersonality(userId, allData) {
    const personality = {
      traits: this.extractPersonalityTraits(allData),
      values: this.extractValues(allData),
      interests: this.extractInterests(allData),
      expertise: this.extractExpertise(allData)
    };

    await this.updateProfile(userId, { personality });
    return personality;
  }

  extractCommonPhrases(emailData) {
    const phrases = [];
    const phraseCounts = {};

    emailData.forEach(email => {
      const text = (email.snippet || '').toLowerCase();
      const sentences = text.split(/[.!?]+/);
      
      sentences.forEach(sentence => {
        const cleaned = sentence.trim();
        if (cleaned.length > 10 && cleaned.length < 100) {
          phraseCounts[cleaned] = (phraseCounts[cleaned] || 0) + 1;
        }
      });
    });

    return Object.entries(phraseCounts)
      .filter(([phrase, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([phrase]) => phrase);
  }

  analyzeResponseTime(emailData) {
    return 'medium';
  }

  analyzeTone(emailData) {
    const professionalWords = ['please', 'thank you', 'regards', 'sincerely'];
    const casualWords = ['thanks', 'hey', 'cool', 'awesome'];
    
    let professionalCount = 0;
    let casualCount = 0;

    emailData.forEach(email => {
      const text = (email.snippet || '').toLowerCase();
      professionalWords.forEach(word => {
        if (text.includes(word)) professionalCount++;
      });
      casualWords.forEach(word => {
        if (text.includes(word)) casualCount++;
      });
    });

    return professionalCount > casualCount ? 'professional' : 'casual';
  }

  analyzeSubjects(emailData) {
    const subjects = emailData.map(email => email.subject || '').filter(s => s);
    return subjects.slice(0, 20);
  }

  analyzeSenders(emailData) {
    const senderCounts = {};
    emailData.forEach(email => {
      const sender = email.from || '';
      if (sender) {
        senderCounts[sender] = (senderCounts[sender] || 0) + 1;
      }
    });

    return Object.entries(senderCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([sender, count]) => ({ sender, count }));
  }

  analyzeMeetingFrequency(calendarData) {
    return calendarData.length;
  }

  analyzeWorkHours(calendarData) {
    const hours = { start: '09:00', end: '17:00' };
    return hours;
  }

  analyzeMeetingTypes(calendarData) {
    const types = {};
    calendarData.forEach(event => {
      const summary = (event.summary || '').toLowerCase();
      if (summary.includes('meeting')) types.meeting = (types.meeting || 0) + 1;
      if (summary.includes('call')) types.call = (types.call || 0) + 1;
      if (summary.includes('review')) types.review = (types.review || 0) + 1;
    });
    return types;
  }

  analyzeBusyDays(calendarData) {
    const dayCounts = {};
    calendarData.forEach(event => {
      const date = new Date(event.start?.dateTime || event.start?.date);
      const day = date.toLocaleDateString();
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    });

    return Object.entries(dayCounts)
      .filter(([day, count]) => count > 3)
      .map(([day]) => day);
  }

  extractPersonalityTraits(allData) {
    return {
      openness: 0.7,
      conscientiousness: 0.6,
      extraversion: 0.5,
      agreeableness: 0.8,
      neuroticism: 0.3
    };
  }

  extractValues(allData) {
    return ['efficiency', 'collaboration', 'innovation'];
  }

  extractInterests(allData) {
    const interests = [];
    
    Object.values(allData).forEach(serviceData => {
      if (serviceData.data) {
        serviceData.data.forEach(item => {
          if (item.summary || item.subject) {
            const text = (item.summary || item.subject || '').toLowerCase();
            if (text.includes('tech')) interests.push('technology');
            if (text.includes('music')) interests.push('music');
            if (text.includes('sport')) interests.push('sports');
          }
        });
      }
    });

    return [...new Set(interests)];
  }

  extractExpertise(allData) {
    return ['software development', 'project management'];
  }

  async storeOAuthTokens(userId, tokens) {
    await this.updateProfile(userId, {
      oauth: {
        googleTokens: tokens,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
      }
    });
  }

  async getOAuthTokens(userId) {
    const profile = this.profiles.get(userId);
    return profile?.oauth?.googleTokens || null;
  }

  async isTokenValid(userId) {
    const profile = this.profiles.get(userId);
    if (!profile?.oauth?.googleTokens) return false;
    
    const expiry = profile.oauth.tokenExpiry;
    if (!expiry) return true; // No expiry info, assume valid
    
    return new Date() < new Date(expiry);
  }

  getProfileAge(userId) {
    const profile = this.profiles.get(userId);
    if (!profile?.createdAt) return null;
    
    const created = new Date(profile.createdAt);
    const now = new Date();
    const diffMs = now - created;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return '1 day';
    if (diffDays < 30) return `${diffDays} days`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} months`;
    return `${Math.floor(diffDays / 365)} years`;
  }

  getProfileStatistics(userId) {
    const profile = this.profiles.get(userId);
    if (!profile) return null;
    
    return {
      dataSourcesConnected: profile.dataHistory?.sources?.length || 0,
      totalDataPoints: profile.dataHistory?.totalDataPoints || 0,
      conversationHistory: profile.context?.recentActivities?.length || 0,
      profileCompleteness: this.calculateProfileCompleteness(profile),
      personalityTrained: (profile.personality?.interests?.length || 0) > 0,
      loginCount: profile.loginHistory?.loginCount || 0,
      lastLogin: profile.loginHistory?.lastLogin,
      accountAge: this.getProfileAge(userId)
    };
  }

  calculateProfileCompleteness(profile) {
    let completeness = 0;
    const fields = [
      profile.personalInfo?.name,
      profile.personalInfo?.email,
      profile.preferences?.communicationStyle,
      profile.dataHistory?.sources?.length > 0,
      profile.personality?.interests?.length > 0,
      profile.patterns?.emailPatterns?.commonPhrases?.length > 0,
      profile.context?.recentActivities?.length > 0
    ];
    
    fields.forEach(field => {
      if (field) completeness += Math.floor(100 / fields.length);
    });
    
    return Math.min(completeness, 100);
  }

  generatePersonalityPrompt(userId) {
    const profile = this.profiles.get(userId);
    if (!profile) return '';

    const { personalInfo, preferences, patterns, personality } = profile;

    return `You are ${personalInfo.name || 'the user'}. Respond naturally as yourself in first person.

Communication Style:
- Formality: ${preferences.formality}
- Response Length: ${preferences.responseLength}
- Tone: ${patterns.emailPatterns?.tone || 'neutral'}
- Use humor: ${preferences.humor ? 'yes' : 'no'}

Personality Traits:
- Openness: ${personality.traits?.openness || 0.5}
- Conscientiousness: ${personality.traits?.conscientiousness || 0.5}
- Extraversion: ${personality.traits?.extraversion || 0.5}

Interests: ${personality.interests?.join(', ') || 'various topics'}
Values: ${personality.values?.join(', ') || 'authenticity, growth'}

Common phrases you use: ${patterns.emailPatterns?.commonPhrases?.slice(0, 3).join(', ') || 'none identified yet'}

Respond as this person would, maintaining their communication style and personality.`;
  }

  deepMerge(target, source) {
    const result = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }
}