const axios = require('axios');
const http = require('http');
const https = require('https');

class MemoryManager {
  /**
   * Memory manager for both real API calls and mock mode
   * Similar to the lambda constants implementation
   */
  constructor(authorization, executionMode = 'execute', mockMemoryData = {}, baseUrl = '') {
    this.authorization = 'bearer ' + authorization;
    this.baseUrl = baseUrl || 'http://agentic-design';
    this.axios = axios;

    // Configure execution mode and mock data
    this.executionMode = executionMode;
    this.mockMemoryData = mockMemoryData || {};

    // Configure axios instance (only needed for real API calls)
    if (this.executionMode !== 'simulate') {
      // Create custom http/https agents that bypass global-agent
      // These agents are NOT instances of http(s).globalAgent, so global-agent won't override them
      // When GLOBAL_AGENT_FORCE_GLOBAL_AGENT=false, global-agent respects custom agents
      const directHttpAgent = new http.Agent({ keepAlive: false });
      const directHttpsAgent = new https.Agent({ keepAlive: false });

      // Create axios instance WITHOUT proxy - uses fresh agents
      // These agents are NOT instances of http(s).globalAgent, so global-agent won't override them
      this.axiosInstance = axios.create({
        baseURL: this.baseUrl,
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authorization,
        },
        timeout: 30000, // 30 seconds timeout
        httpAgent: directHttpAgent,
        httpsAgent: directHttpsAgent,
        proxy: false, // Disable axios's built-in proxy
      });
    }
  }

  async makeRequest(body) {
    // If in simulate mode, use mock data instead of API calls
    if (this.executionMode === 'simulate') {
      return this.handleMockRequest(body);
    }

    // Otherwise, make real API call
    try {
      const response = await this.axiosInstance.post('api/v1/memory', body);
      return response.data;
    } catch (error) {
      console.error('Memory API request failed:', error.message);
      if (error.response) {
        throw new Error(`Memory API error: ${error.response.status} - ${error.response.data}`);
      } else if (error.request) {
        throw new Error('Memory API request failed: No response received');
      } else {
        throw new Error(`Memory API request failed: ${error.message}`);
      }
    }
  }

  handleMockRequest(body) {
    const {
      action,
      memoryStoreName,
      payload,
      projections,
      key,
      patchMode,
      upsert,
      searchType,
      query,
      filters,
      options,
    } = body;
    const storageKey = key ? `${memoryStoreName}_${key}` : memoryStoreName;

    switch (action) {
      case 'set':
        this.mockMemoryData[storageKey] = payload.content;
        return {
          success: true,
          message: `Content set successfully for ${storageKey}`,
          data: payload.content,
        };

      case 'update':
        const existingContent = this.mockMemoryData[storageKey];
        if (existingContent === undefined) {
          if (upsert) {
            this.mockMemoryData[storageKey] = payload.content;
            return {
              success: true,
              message: `Content created successfully for ${storageKey}`,
              data: payload.content,
            };
          } else {
            return {
              success: false,
              message: `No content found for ${storageKey}`,
              data: null,
            };
          }
        }
        let updatedContent;
        if (patchMode === 'overwrite') {
          updatedContent = payload.content;
        } else {
          if (typeof existingContent === 'object' && typeof payload.content === 'object') {
            updatedContent = { ...existingContent, ...payload.content };
          } else {
            updatedContent = payload.content;
          }
        }
        this.mockMemoryData[storageKey] = updatedContent;
        return {
          success: true,
          message: `Content updated successfully for ${storageKey}`,
          data: updatedContent,
        };

      case 'get':
        const content = this.mockMemoryData[storageKey];
        if (content === undefined) {
          return {
            success: false,
            message: `No content found for ${storageKey}`,
            data: null,
          };
        }
        let result = content;
        if (projections && Object.keys(projections).length > 0) {
          if (typeof content === 'object' && content !== null) {
            result = {};
            Object.keys(projections).forEach((key) => {
              if (content.hasOwnProperty(key)) {
                result[key] = content[key];
              }
            });
          }
        }
        return {
          success: true,
          message: `Content retrieved successfully for ${storageKey}`,
          data: result,
        };

      case 'delete':
        const existed = this.mockMemoryData.hasOwnProperty(storageKey);
        delete this.mockMemoryData[storageKey];
        return {
          success: true,
          message: `Content deleted successfully for ${storageKey}`,
          data: { existed },
        };

      case 'search':
        // Mock search implementation
        const results = [];
        const searchQuery = query ? query.toLowerCase() : '';

        // Search through all stored data
        for (const [storeKey, storeContent] of Object.entries(this.mockMemoryData)) {
          // Check if this is the correct memory store
          if (!storeKey.startsWith(memoryStoreName)) {
            continue;
          }

          let matches = false;

          // Apply filters if provided
          if (filters && Object.keys(filters).length > 0) {
            matches = this._matchesFilters(storeContent, filters);
            if (!matches) continue;
          }

          // Apply search query
          if (searchQuery) {
            if (searchType === 'keyword') {
              // Keyword search - exact match
              matches = this._keywordSearch(storeContent, searchQuery, options?.exactMatch);
            } else {
              // Semantic search - simplified (just contains check)
              matches = this._semanticSearch(storeContent, searchQuery);
            }
          } else {
            // No query means return all matching filters
            matches = true;
          }

          if (matches) {
            results.push({
              key: storeKey,
              content: storeContent,
              score: 1.0, // Mock score
            });
          }
        }

        // Apply topK limit
        const topK = options?.topK || 10;
        const limitedResults = results.slice(0, topK);

        return {
          success: true,
          message: `Search completed for ${memoryStoreName}`,
          data: {
            results: limitedResults,
            total: results.length,
          },
        };

      default:
        throw new Error(`[MOCK] Unsupported action: ${action}`);
    }
  }

  _matchesFilters(content, filters) {
    for (const [filterPath, filterValue] of Object.entries(filters)) {
      const actualValue = this._getNestedValue(content, filterPath);
      if (actualValue !== filterValue) {
        return false;
      }
    }
    return true;
  }

  _getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  _keywordSearch(content, query, exactMatch) {
    const contentStr = JSON.stringify(content).toLowerCase();
    if (exactMatch) {
      return contentStr.includes(query);
    }
    return contentStr.includes(query);
  }

  _semanticSearch(content, query) {
    // Simplified semantic search - just check if query terms are in content
    const contentStr = JSON.stringify(content).toLowerCase();
    return contentStr.includes(query);
  }

  async set_content(memoryStoreName, content) {
    try {
      const body = {
        action: 'set',
        memoryStoreName: memoryStoreName,
        payload: {
          content: content,
        },
      };
      return await this.makeRequest(body);
    } catch (error) {
      console.error('Error setting memory content:', error.message);
      throw error;
    }
  }

  async get_content(memoryStoreName, projections = {}) {
    try {
      const body = {
        action: 'get',
        memoryStoreName: memoryStoreName,
        projections: projections,
      };
      return await this.makeRequest(body);
    } catch (error) {
      console.error('Error getting memory content:', error.message);
      throw error;
    }
  }

  async delete_content(memoryStoreName) {
    try {
      const body = {
        action: 'delete',
        memoryStoreName: memoryStoreName,
      };
      return await this.makeRequest(body);
    } catch (error) {
      console.error('Error deleting memory content:', error.message);
      throw error;
    }
  }

  async set(memoryStoreName, key, content) {
    try {
      const body = {
        action: 'set',
        memoryStoreName: memoryStoreName,
        key: key,
        payload: {
          content: content,
        },
      };
      return await this.makeRequest(body);
    } catch (error) {
      console.error('Error setting memory with key:', error.message);
      throw error;
    }
  }

  async update(memoryStoreName, key, patch, patchMode = 'merge', upsert = false) {
    try {
      const body = {
        action: 'update',
        memoryStoreName: memoryStoreName,
        key: key,
        patchMode: patchMode,
        upsert: upsert,
        payload: {
          content: patch,
        },
      };
      return await this.makeRequest(body);
    } catch (error) {
      console.error('Error updating memory:', error.message);
      throw error;
    }
  }

  async get(memoryStoreName, key, projections = {}) {
    try {
      const body = {
        action: 'get',
        memoryStoreName: memoryStoreName,
        key: key,
        projections: projections,
      };
      return await this.makeRequest(body);
    } catch (error) {
      console.error('Error getting memory with key:', error.message);
      throw error;
    }
  }

  async delete(memoryStoreName, key) {
    try {
      const body = {
        action: 'delete',
        memoryStoreName: memoryStoreName,
        key: key,
      };
      return await this.makeRequest(body);
    } catch (error) {
      console.error('Error deleting memory with key:', error.message);
      throw error;
    }
  }

  async search(memoryStoreName, query = '', filters = {}, options = {}) {
    try {
      const body = {
        action: 'search',
        memoryStoreName: memoryStoreName,
        query: query,
        filters: filters,
        options: options,
      };
      return await this.makeRequest(body);
    } catch (error) {
      console.error('Error searching memory:', error.message);
      throw error;
    }
  }
}

module.exports = {
  MemoryManager,
};
