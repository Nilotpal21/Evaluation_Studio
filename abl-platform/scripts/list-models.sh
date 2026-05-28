#!/bin/bash
# List models from LLM providers

case "$1" in
  openai)
    echo "📦 Fetching OpenAI models..."
    curl -s https://api.openai.com/v1/models \
      -H "Authorization: Bearer $OPENAI_API_KEY" | \
      jq -r '.data[] | select(.id | test("gpt-|o1|o3")) | .id' | sort
    ;;
    
  google|gemini)
    echo "📦 Fetching Google Gemini models..."
    curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GOOGLE_API_KEY" | \
      jq -r '.models[] | select(.supportedGenerationMethods[] | contains("generateContent")) | .name' | \
      sed 's/models\///' | sort
    ;;
    
  anthropic)
    echo "📦 Anthropic Claude models:"
    echo "  claude-opus-4-20250514"
    echo "  claude-sonnet-4-5-20250514"
    echo "  claude-sonnet-4-20250514"
    echo "  claude-haiku-4-5-20251022"
    echo "  claude-3-7-sonnet-20250219"
    echo "  claude-3-5-sonnet-20241022"
    echo "  claude-3-5-haiku-20241022"
    echo "  claude-3-opus-20240229"
    echo ""
    echo "Note: Anthropic doesn't provide a models API."
    echo "See: https://docs.anthropic.com/en/docs/about-claude/models"
    ;;
    
  registry|*)
    echo "📦 Models from our MODEL_REGISTRY:"
    node -e "
      const r = require('./packages/compiler/dist/platform/llm/model-registry.js');
      const bp = {};
      Object.entries(r.MODEL_REGISTRY).forEach(([id, m]) => {
        bp[m.provider] = (bp[m.provider] || 0) + 1;
      });
      console.log('\nTotal: ' + Object.keys(r.MODEL_REGISTRY).length + ' models\n');
      Object.entries(bp).sort((a,b) => b[1] - a[1]).forEach(([p, c]) => {
        console.log('  ' + p.padEnd(15) + c + ' models');
      });
    "
    ;;
esac
