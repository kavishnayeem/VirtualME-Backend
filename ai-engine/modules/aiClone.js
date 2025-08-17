import Groq from "groq-sdk";

export class AICloneService {
  constructor(apiKey) {
    this.groq = new Groq({ apiKey });
    this.model = "llama-3.1-8b-instant"; // Fast and capable model
    this.conversationHistory = new Map();
    this.maxHistoryLength = 20;
  }

  async generateResponse(userId, message, context = {}) {
    try {
      const { personalityPrompt, userProfile, additionalContext } = context;
      
      const prompt = this.buildPrompt({
        userId,
        message,
        personalityPrompt,
        userProfile,
        additionalContext,
        conversationHistory: this.getConversationHistory(userId)
      });

      const result = await this.groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: this.model,
        temperature: 0.5,
        max_tokens: 1000
      });
      const text = result.choices[0].message.content;

      this.addToConversationHistory(userId, message, text);

      return {
        response: text,
        userId,
        timestamp: new Date().toISOString(),
        context: {
          promptUsed: personalityPrompt ? 'personalized' : 'default',
          hasHistory: this.conversationHistory.has(userId)
        }
      };
    } catch (error) {
      console.error('AI Clone generation error:', error);
      throw error;
    }
  }

  buildPrompt({ userId, message, personalityPrompt, userProfile, additionalContext, conversationHistory }) {
    let prompt = '';
    
    console.log("DEBUG - Building prompt with:");
    console.log("- personalityPrompt:", personalityPrompt ? personalityPrompt : "missing");
    console.log("- additionalContext:", additionalContext ? additionalContext : "missing");
    console.log("- userProfile name:", userProfile?.personalInfo?.name || "unknown");

    if (personalityPrompt) {
      prompt += `${personalityPrompt}\n\n`;
    } else {
      prompt += `You are ${userProfile?.personalInfo?.name || 'the user'}. `;
      prompt += `Respond naturally as yourself in first person. Do not mention that you are an AI, clone, or digital assistant. `;
      prompt += `Answer questions about your life, schedule, preferences, and experiences based on your data. `;
      prompt += `Speak as if you're responding directly to someone asking you questions.\n\n`;
      
      // CRITICAL: Date and schedule accuracy warnings
      prompt += `🚨 CRITICAL INSTRUCTIONS FOR DATES AND AVAILABILITY:\n`;
      prompt += `- Be EXTREMELY accurate with dates and times from your calendar\n`;
      prompt += `- NEVER confuse events from yesterday, today, or tomorrow\n`;
      prompt += `- When someone asks about your availability, check your actual schedule first\n`;
      prompt += `- If you're busy during a time, clearly state what meeting/event you have\n`;
      prompt += `- If you're free, explicitly say you're available\n`;
      prompt += `- Always reference the correct day when mentioning events\n`;
      prompt += `- Do NOT hallucinate or make up meetings that aren't in your calendar\n\n`;
    }

    if (userProfile) {
      prompt += `Additional context about the user:\n`;
      
      if (userProfile.personalInfo) {
        prompt += `Name: ${userProfile.personalInfo.name || 'Unknown'}\n`;
        prompt += `Language: ${userProfile.personalInfo.language || 'English'}\n`;
      }

      if (userProfile.preferences) {
        prompt += `Communication style: ${userProfile.preferences.communicationStyle || 'neutral'}\n`;
        prompt += `Preferred response length: ${userProfile.preferences.responseLength || 'medium'}\n`;
        prompt += `Formality level: ${userProfile.preferences.formality || 'casual'}\n`;
      }

      if (userProfile.personality?.interests?.length > 0) {
        prompt += `Interests: ${userProfile.personality.interests.join(', ')}\n`;
      }

      prompt += '\n';
    }

    if (additionalContext) {
      prompt += `Your current context: ${additionalContext}\n\n`;
    }

    if (conversationHistory.length > 0) {
      prompt += `Recent conversation history:\n`;
      conversationHistory.forEach(({ userMessage, aiResponse }, index) => {
        prompt += `${index + 1}. User: ${userMessage}\n`;
        prompt += `   You: ${aiResponse}\n`;
      });
      prompt += '\n';
    }

    prompt += `Someone is asking you: "${message}"\n\n`;
    prompt += `REMEMBER: Be precise with dates/times. Check your calendar before stating availability. Don't confuse yesterday/today/tomorrow events.\n\n`;
    prompt += `Respond naturally as yourself:`;

    return prompt;
  }

  async analyzeUserMessage(message) {
    try {
      const analysisPrompt = `Analyze the following user message and extract:
1. Intent (question, request, statement, etc.)
2. Emotional tone (positive, negative, neutral, excited, etc.)
3. Key topics mentioned
4. Urgency level (low, medium, high)
5. Context clues about the user's current situation

Message: "${message}"

Provide a JSON response with these fields: intent, tone, topics, urgency, contextClues`;

      const result = await this.groq.chat.completions.create({
        messages: [{ role: "user", content: analysisPrompt }],
        model: this.model,
        temperature: 0.3,
        max_tokens: 500
      });
      const text = result.choices[0].message.content;

      try {
        return JSON.parse(text);
      } catch (parseError) {
        return {
          intent: 'unknown',
          tone: 'neutral',
          topics: [],
          urgency: 'medium',
          contextClues: text
        };
      }
    } catch (error) {
      console.error('Message analysis error:', error);
      return {
        intent: 'unknown',
        tone: 'neutral',
        topics: [],
        urgency: 'medium',
        contextClues: ''
      };
    }
  }

  async suggestPersonalityAdjustments(userId, conversationData) {
    try {
      const prompt = `Based on the following conversation data, suggest personality adjustments for the AI clone:

Conversation data:
${JSON.stringify(conversationData, null, 2)}

Analyze:
1. Communication patterns that should be adjusted
2. Missing personality traits that should be added
3. Response style improvements
4. Better ways to match the user's communication style

Provide suggestions as a JSON object with fields: adjustments, newTraits, styleImprovements, communicationMatches`;

      const result = await this.groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: this.model,
        temperature: 0.5,
        max_tokens: 800
      });
      const text = result.choices[0].message.content;

      try {
        return JSON.parse(text);
      } catch (parseError) {
        return {
          adjustments: [],
          newTraits: [],
          styleImprovements: [],
          communicationMatches: []
        };
      }
    } catch (error) {
      console.error('Personality adjustment error:', error);
      throw error;
    }
  }

  getConversationHistory(userId) {
    return this.conversationHistory.get(userId) || [];
  }

  addToConversationHistory(userId, userMessage, aiResponse) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }

    const history = this.conversationHistory.get(userId);
    history.push({
      userMessage,
      aiResponse,
      timestamp: new Date().toISOString()
    });

    if (history.length > this.maxHistoryLength) {
      history.shift();
    }

    this.conversationHistory.set(userId, history);
  }

  clearConversationHistory(userId) {
    this.conversationHistory.delete(userId);
  }

  async generateContextAwareResponse(userId, message, recentData = {}) {
    try {
      let contextualInfo = '';

      if (recentData.emails) {
        contextualInfo += `Recent emails: You've received ${recentData.emails.length} emails recently. `;
        if (recentData.emails.length > 0) {
          contextualInfo += `Latest from: ${recentData.emails[0].from}. `;
        }
      }

      if (recentData.calendar) {
        contextualInfo += `Upcoming events: You have ${recentData.calendar.length} events. `;
        if (recentData.calendar.length > 0) {
          contextualInfo += `Next: ${recentData.calendar[0].summary}. `;
        }
      }

      if (recentData.activity) {
        contextualInfo += `Recent activity: ${recentData.activity}. `;
      }

      return await this.generateResponse(userId, message, {
        additionalContext: contextualInfo
      });
    } catch (error) {
      console.error('Context-aware response error:', error);
      throw error;
    }
  }

  async trainFromConversation(userId, conversationData) {
    const suggestions = await this.suggestPersonalityAdjustments(userId, conversationData);
    
    return {
      userId,
      trainingSuggestions: suggestions,
      conversationAnalysis: {
        messageCount: conversationData.length,
        avgResponseLength: this.calculateAverageResponseLength(conversationData),
        commonTopics: this.extractCommonTopics(conversationData)
      },
      timestamp: new Date().toISOString()
    };
  }

  calculateAverageResponseLength(conversationData) {
    if (!conversationData.length) return 0;
    
    const totalLength = conversationData.reduce((sum, conv) => 
      sum + (conv.aiResponse?.length || 0), 0);
    
    return Math.round(totalLength / conversationData.length);
  }

  extractCommonTopics(conversationData) {
    const topicCounts = {};
    
    conversationData.forEach(conv => {
      const message = conv.userMessage?.toLowerCase() || '';
      
      if (message.includes('work') || message.includes('job')) {
        topicCounts.work = (topicCounts.work || 0) + 1;
      }
      if (message.includes('family') || message.includes('home')) {
        topicCounts.personal = (topicCounts.personal || 0) + 1;
      }
      if (message.includes('project') || message.includes('task')) {
        topicCounts.projects = (topicCounts.projects || 0) + 1;
      }
    });

    return Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic, count]) => ({ topic, count }));
  }
}