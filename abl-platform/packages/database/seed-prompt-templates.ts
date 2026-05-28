import { PromptTemplate } from './src/models/prompt-template.model.js';
import { PromptCatalog } from '../shared/src/prompts/prompt-catalog.js';

interface SeedEntry {
  key: string;
  category:
    | 'system_prompt'
    | 'tool_schema'
    | 'tool_description'
    | 'message'
    | 'escalation'
    | 'pattern'
    | 'llm_prompt'
    | 'arch';
  content: unknown;
  description?: string;
}

export function getPromptTemplateSeedEntries(): SeedEntry[] {
  const entries: SeedEntry[] = [];

  for (const [name, template] of Object.entries(PromptCatalog.systemPrompt)) {
    entries.push({
      key: `system_prompt.${name}`,
      category: 'system_prompt',
      content: template,
      description: `System prompt template for ${name} agent type`,
    });
  }

  for (const [name, prompt] of Object.entries(PromptCatalog.llmPrompts)) {
    entries.push({
      key: `llm_prompt.${name}`,
      category: 'llm_prompt',
      content: prompt,
      description: `LLM task prompt: ${name.replace(/_/g, ' ')}`,
    });
  }

  for (const [name, schema] of Object.entries(PromptCatalog.toolSchemas)) {
    entries.push({
      key: `tool_schema.${name}`,
      category: 'tool_schema',
      content: schema,
      description: `JSON schema for __${name}__ system tool`,
    });
  }

  for (const [name, desc] of Object.entries(PromptCatalog.sharedDescriptions)) {
    entries.push({
      key: `tool_description.shared.${name}`,
      category: 'tool_description',
      content: desc,
      description: `Shared property description: ${name}`,
    });
  }

  for (const [toolName, descs] of Object.entries(PromptCatalog.toolDescriptions)) {
    if (typeof descs === 'string') {
      entries.push({
        key: `tool_description.${toolName}`,
        category: 'tool_description',
        content: descs,
      });
    } else {
      for (const [subKey, desc] of Object.entries(descs as Record<string, string>)) {
        entries.push({
          key: `tool_description.${toolName}.${subKey}`,
          category: 'tool_description',
          content: desc,
        });
      }
    }
  }

  for (const [name, msg] of Object.entries(PromptCatalog.messages)) {
    entries.push({
      key: `message.${name}`,
      category: 'message',
      content: msg,
    });
  }

  for (const [name, tmpl] of Object.entries(PromptCatalog.escalation)) {
    entries.push({
      key: `escalation.${name}`,
      category: 'escalation',
      content: tmpl,
    });
  }

  if (PromptCatalog.voiceFormatRules) {
    entries.push({
      key: 'pattern.voice_format_rules',
      category: 'pattern',
      content: PromptCatalog.voiceFormatRules,
      description: 'Voice channel response format rules',
    });
  }

  for (const [section, prompts] of Object.entries(PromptCatalog.arch)) {
    for (const [name, content] of Object.entries(prompts as Record<string, string>)) {
      entries.push({
        key: `arch.${section}.${name}`,
        category: 'arch',
        content,
        description: `Arch ${section} prompt: ${name.replace(/_/g, ' ')}`,
      });
    }
  }

  return entries;
}

export async function seedPromptTemplates(): Promise<number> {
  const entries = getPromptTemplateSeedEntries();
  let upsertCount = 0;

  for (const entry of entries) {
    await PromptTemplate.findOneAndUpdate(
      { key: entry.key },
      {
        $set: {
          category: entry.category,
          content: entry.content,
          description: entry.description,
          version: 1,
        },
      },
      { upsert: true, new: true },
    );
    upsertCount++;
  }

  return upsertCount;
}
