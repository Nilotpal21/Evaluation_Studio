/**
 * Example Projects Seed — demo content for development.
 *
 * Seeds: example projects, agents, tools, agent versions, deployments,
 * project environment variables, and project-level configs (ModelConfig,
 * ProjectLLMConfig, ProjectSettings).
 *
 * This is optional — the application runs without it.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { Project } from './src/models/project.model.js';
import { ProjectAgent } from './src/models/project-agent.model.js';
import { ProjectTool } from './src/models/project-tool.model.js';
import { EnvironmentVariable } from './src/models/environment-variable.model.js';
import { AgentVersion } from './src/models/agent-version.model.js';
import { Deployment } from './src/models/deployment.model.js';
import { ModelConfig } from './src/models/model-config.model.js';
import { ProjectLLMConfig } from './src/models/project-llm-config.model.js';
import { TenantModel } from './src/models/tenant-model.model.js';
import { collectInlineSeedTools } from './seed-inline-tools.js';
import { CURATED_EXAMPLE_PROJECTS } from './src/seed/example-projects.js';
import { upsertOne } from './src/seed/upsert-helpers.js';
import { isFacadeEncryptionAvailable } from './src/mongo/plugins/encryption.plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = fs.existsSync(path.resolve(__dirname, '../../examples'))
  ? path.resolve(__dirname, '../../examples')
  : path.resolve(__dirname, './examples');

// =============================================================================
// EXAMPLE DIRECTORIES
// =============================================================================

const EXAMPLE_DIRS = CURATED_EXAMPLE_PROJECTS;

// =============================================================================
// MAIN
// =============================================================================

export async function seedExamples(tenantId: string, userId: string): Promise<void> {
  // =========================================================================
  // 1. Create projects from examples
  // =========================================================================
  console.log('\n--- Seeding Projects ---');

  for (const example of EXAMPLE_DIRS) {
    const exDir = path.join(EXAMPLES_DIR, example.dir);
    if (!fs.existsSync(exDir)) {
      console.log(`Skipping ${example.dir} — directory not found`);
      continue;
    }

    const projectId = `proj-${example.dir}`;
    await upsertOne(
      Project,
      { _id: projectId },
      {
        _id: projectId,
        name: example.name,
        slug: example.dir,
        description: example.description,
        tenantId,
        ownerId: userId,
      },
      {
        name: example.name,
        description: example.description,
      },
    );
    console.log(`Project: ${example.name} (${projectId})`);

    // Load agent files from root and agents/ subdirectory
    const ablFiles: Array<{ file: string; subdir: string }> = [];
    const seededAgentSpecs: Array<{ name: string; dslContent: string }> = [];
    const seededToolNames = new Set<string>();

    // Root-level .abl files
    for (const f of fs.readdirSync(exDir).filter((f) => f.endsWith('.abl'))) {
      ablFiles.push({ file: f, subdir: '' });
    }

    // agents/ subdirectory .abl files
    const agentsSubdir = path.join(exDir, 'agents');
    if (fs.existsSync(agentsSubdir)) {
      for (const f of fs.readdirSync(agentsSubdir).filter((f) => f.endsWith('.abl'))) {
        ablFiles.push({ file: f, subdir: 'agents/' });
      }
    }

    for (const { file: ablFile, subdir } of ablFiles) {
      const agentName = ablFile.replace('.agent.abl', '').replace('.abl', '');
      const spec = fs.readFileSync(path.join(exDir, subdir, ablFile), 'utf-8');
      const agentId = `agent-${example.dir}-${agentName}`;

      await upsertOne(
        ProjectAgent,
        { projectId, name: agentName },
        {
          _id: agentId,
          tenantId,
          projectId,
          name: agentName,
          agentPath: `${example.dir}/${subdir}${agentName}`,
          dslContent: spec,
        },
        {
          tenantId,
          dslContent: spec,
        },
      );
      seededAgentSpecs.push({ name: agentName, dslContent: spec });
      console.log(`  Agent: ${agentName} (${subdir}${ablFile})`);
    }

    // Load tool files from tools/ subdirectory
    const toolsSubdir = path.join(exDir, 'tools');
    if (fs.existsSync(toolsSubdir)) {
      const toolFiles = fs.readdirSync(toolsSubdir).filter((f) => f.endsWith('.tools.abl'));
      for (const toolFile of toolFiles) {
        const fileContent = fs.readFileSync(path.join(toolsSubdir, toolFile), 'utf-8');

        // Extract shared defaults from TOOLS: block header
        const lines = fileContent.split('\n');
        const sharedDefaults: Record<string, string> = {};
        const sharedBlocks: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          if (trimmed.match(/^\w+\s*\(.*\)\s*->\s*.+$/)) {
            break;
          }
          if (
            trimmed === 'TOOLS:' ||
            trimmed.startsWith('#') ||
            trimmed.startsWith('/*') ||
            trimmed.startsWith('*') ||
            trimmed.startsWith('*/') ||
            !trimmed
          )
            continue;
          const propMatch = trimmed.match(/^([a-z_]+)\s*:\s*(.+)$/);
          if (propMatch) {
            sharedDefaults[propMatch[1]] = propMatch[2].replace(/^["']|["']$/g, '').trim();
          }
          const blockMatch = trimmed.match(/^([a-z_]+)\s*:\s*$/);
          if (blockMatch) {
            const blockName = blockMatch[1];
            const blockLines: string[] = [`  ${blockName}:`];
            for (let j = i + 1; j < lines.length; j++) {
              const bl = lines[j];
              if (bl.trim() === '' || bl.trim().match(/^\w+\s*\(.*\)\s*->/)) break;
              const blIndent = bl.length - bl.trimStart().length;
              if (blIndent <= lines[i].length - trimmed.length) break;
              blockLines.push(bl.trimStart().replace(/^/, '    '));
            }
            if (blockLines.length > 1) {
              sharedBlocks.push(blockLines.join('\n'));
            }
          }
        }

        // Extract individual tools from the file
        const toolEntries: Array<{ name: string; startLine: number }> = [];
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          const sigMatch = trimmed.match(/^(\w+)\s*\(.*\)\s*->\s*.+$/);
          if (sigMatch) {
            toolEntries.push({ name: sigMatch[1], startLine: i });
          }
        }

        for (let t = 0; t < toolEntries.length; t++) {
          const { name, startLine } = toolEntries[t];
          const sigLine = lines[startLine];
          const sigIndent = sigLine.length - sigLine.trimStart().length;

          const toolLines: string[] = [sigLine.trimStart()];
          for (let j = startLine + 1; j < lines.length; j++) {
            const line = lines[j];
            if (line.trim() === '') {
              toolLines.push('');
              continue;
            }
            const indent = line.length - line.trimStart().length;
            if (indent <= sigIndent) break;
            toolLines.push(line.slice(sigIndent + 2));
          }

          while (toolLines.length > 0 && toolLines[toolLines.length - 1].trim() === '') {
            toolLines.pop();
          }

          let toolDsl = toolLines.join('\n');

          // Merge shared defaults into the per-tool DSL
          if (sharedDefaults.base_url) {
            toolDsl = toolDsl.replace(/^(\s*endpoint:\s*)"(.+?)"/m, (_, prefix, ep) =>
              ep.startsWith('http')
                ? `${prefix}"${ep}"`
                : `${prefix}"${sharedDefaults.base_url}${ep}"`,
            );
            toolDsl = toolDsl.replace(
              /^(\s*endpoint:\s*)(\/\S+)/m,
              (_, prefix, ep) => `${prefix}"${sharedDefaults.base_url}${ep}"`,
            );
          }
          if (sharedDefaults.auth && !/^\s*auth\s*:/m.test(toolDsl)) {
            toolDsl += `\nauth: ${sharedDefaults.auth}`;
          }
          if (sharedDefaults.timeout && !/^\s*timeout\s*:/m.test(toolDsl)) {
            toolDsl += `\ntimeout: ${sharedDefaults.timeout}`;
          }
          for (const block of sharedBlocks) {
            const blockName = block.match(/^\s*(\w+):/)?.[1];
            if (blockName && !new RegExp(`^\\s*${blockName}\\s*:`, 'm').test(toolDsl)) {
              // Dedent shared blocks to indent 0 so they don't get captured
              // by extractPipeBlock as body_template content
              const dedented = block.replace(/^  /gm, '');
              toolDsl += '\n' + dedented;
            }
          }

          // Infer tool type from DSL properties
          let toolType: 'http' | 'mcp' | 'sandbox' | 'searchai' | 'workflow' = 'http';
          if (/^\s*type:\s*sandbox/m.test(toolDsl)) toolType = 'sandbox';
          else if (/^\s*type:\s*mcp/m.test(toolDsl)) toolType = 'mcp';
          else if (/^\s*type:\s*searchai/m.test(toolDsl)) toolType = 'searchai';

          const descMatch = toolDsl.match(/^\s*description:\s*"(.+?)"/m);
          const description = descMatch ? descMatch[1] : null;

          // Hash per-tool DSL (not the file) so each tool gets a unique sourceHash
          const sourceHash = crypto.createHash('sha256').update(toolDsl, 'utf8').digest('hex');

          const toolId = `tool-${example.dir}-${name}`;

          await upsertOne(
            ProjectTool,
            { projectId, tenantId, name },
            {
              _id: toolId,
              tenantId,
              projectId,
              name,
              slug: name,
              toolType,
              description,
              dslContent: toolDsl,
              sourceHash,
              createdBy: userId,
              lastEditedBy: userId,
            },
            {
              tenantId,
              dslContent: toolDsl,
              toolType,
              description,
              sourceHash,
              lastEditedBy: userId,
            },
          );
          seededToolNames.add(name);
          console.log(`  Tool: ${name} (${toolFile}) [${toolType}]`);
        }
      }
    }

    for (const tool of collectInlineSeedTools(seededAgentSpecs)) {
      if (seededToolNames.has(tool.name)) {
        continue;
      }

      const toolId = `tool-${example.dir}-${tool.name}`;
      await upsertOne(
        ProjectTool,
        { projectId, tenantId, name: tool.name },
        {
          _id: toolId,
          tenantId,
          projectId,
          name: tool.name,
          slug: tool.name,
          toolType: tool.toolType,
          description: tool.description,
          dslContent: tool.dslContent,
          sourceHash: tool.sourceHash,
          createdBy: userId,
          lastEditedBy: userId,
        },
        {
          tenantId,
          dslContent: tool.dslContent,
          toolType: tool.toolType,
          description: tool.description,
          sourceHash: tool.sourceHash,
          lastEditedBy: userId,
        },
      );
      seededToolNames.add(tool.name);
      console.log(`  Tool: ${tool.name} (inline) [${tool.toolType}]`);
    }
  }

  // =========================================================================
  // 2. Seed project environment variables
  // =========================================================================
  console.log('\n--- Seeding Project Environment Variables ---');

  const projectEnvVars: Array<{
    projectId: string;
    vars: Array<{ key: string; value: string; isSecret: boolean; description: string }>;
  }> = [
    {
      projectId: 'proj-saludsa-production',
      vars: [
        {
          key: 'SALUDSA_MCP_ENDPOINT',
          value: 'https://your-host/servicioalcliente/mcpintegracionivr/api/v1',
          isSecret: false,
          description: 'Saludsa MCP server base URL — set the real value in Studio after import',
        },
        {
          key: 'SALUDSA_MCP_AUTH',
          value: 'Basic PLACEHOLDER',
          isSecret: true,
          description:
            'Basic auth credentials for MCP server — set the real value in Studio after import',
        },
      ],
    },
  ];

  const envVarsByProject = new Map<string, Record<string, string>>();
  if (!isFacadeEncryptionAvailable()) {
    console.log('  Skipping encrypted project environment variables (DEK facade unavailable).');
  } else {
    for (const { projectId: envProjectId, vars } of projectEnvVars) {
      const map: Record<string, string> = {};
      for (const v of vars) {
        // EnvironmentVariable has encryptionPlugin on 'encryptedValue', which blocks
        // findOneAndUpdate. Use find-or-create with save() so the plugin can encrypt.
        let envVar = await EnvironmentVariable.findOne({
          tenantId,
          projectId: envProjectId,
          environment: 'global',
          key: v.key,
        });
        if (envVar) {
          envVar.set('encryptedValue', v.value);
          envVar.set('isSecret', v.isSecret);
          envVar.set('description', v.description);
          envVar.set('updatedBy', userId);
          await envVar.save();
        } else {
          envVar = new EnvironmentVariable({
            tenantId,
            projectId: envProjectId,
            environment: 'global',
            key: v.key,
            encryptedValue: v.value,
            isSecret: v.isSecret,
            description: v.description,
            createdBy: userId,
          });
          await envVar.save();
        }
        map[v.key] = v.value;
        console.log(`  ${envProjectId}: ${v.key} ${v.isSecret ? '(secret)' : ''}`);
      }
      envVarsByProject.set(envProjectId, map);
    }
  }

  // =========================================================================
  // 3. Compile agent versions and create deployments
  // =========================================================================
  console.log('\n--- Compiling Agent Versions & Creating Deployments ---');

  const { parseAgentBasedABL } = await import('@abl/core');
  const { compileABLtoIR } = await import('@abl/compiler');

  for (const example of EXAMPLE_DIRS) {
    const projectId = `proj-${example.dir}`;
    const exDir = path.join(EXAMPLES_DIR, example.dir);
    if (!fs.existsSync(exDir)) continue;

    const projectJsonPath = path.join(exDir, 'project.json');
    if (!fs.existsSync(projectJsonPath)) continue;

    let projectConfig: { entry_agent?: string };
    try {
      projectConfig = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
    } catch {
      continue;
    }
    if (!projectConfig.entry_agent) continue;

    console.log(`  [${example.dir}] entry_agent: ${projectConfig.entry_agent}, parsing agents...`);

    const agentDSLs: Array<{ name: string; dsl: string; agentId: string }> = [];
    const allABLPaths: Array<{ file: string; subdir: string }> = [];

    for (const f of fs.readdirSync(exDir).filter((f) => f.endsWith('.agent.abl'))) {
      allABLPaths.push({ file: f, subdir: '' });
    }
    const agentsDir = path.join(exDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const f of fs.readdirSync(agentsDir).filter((f) => f.endsWith('.agent.abl'))) {
        allABLPaths.push({ file: f, subdir: 'agents/' });
      }
    }

    for (const { file, subdir } of allABLPaths) {
      const name = file.replace('.agent.abl', '');
      const dsl = fs.readFileSync(path.join(exDir, subdir, file), 'utf-8');
      agentDSLs.push({ name, dsl, agentId: `agent-${example.dir}-${name}` });
    }

    if (agentDSLs.length === 0) {
      console.log(`  [${example.dir}] no agent DSLs found`);
      continue;
    }
    console.log(`  [${example.dir}] ${agentDSLs.length} agents, parsing...`);

    const documents: any[] = [];
    for (const { dsl } of agentDSLs) {
      const result = parseAgentBasedABL(dsl);
      if (result.document) documents.push(result.document);
    }
    if (documents.length === 0) {
      console.log(`  [${example.dir}] no parsed documents`);
      continue;
    }
    console.log(`  [${example.dir}] ${documents.length} parsed, compiling...`);

    // Resolve tool implementations from project_tools DB
    const toolsByAgent = new Map<string, string[]>();
    for (const doc of documents) {
      const names = (doc.tools ?? []).map((t: { name: string }) => t.name).filter(Boolean);
      if (names.length > 0) toolsByAgent.set(doc.name, names);
    }

    let resolvedTools: Map<string, any[]> | undefined;
    if (toolsByAgent.size > 0) {
      const allToolNames = [...new Set([...toolsByAgent.values()].flat())];
      const dbTools = await ProjectTool.find({
        tenantId,
        projectId,
        name: { $in: allToolNames },
      }).lean();

      if (dbTools.length > 0) {
        const toolMap = new Map(dbTools.map((t: any) => [t.name, t]));
        resolvedTools = new Map();

        for (const [agentName, toolNames] of toolsByAgent) {
          const agentTools: any[] = [];
          for (const toolName of toolNames) {
            const dbTool = toolMap.get(toolName) as any;
            if (!dbTool) continue;

            const dslLines = (dbTool.dslContent as string).split('\n');
            const props: Record<string, string> = {};
            for (let i = 1; i < dslLines.length; i++) {
              const trimmed = dslLines[i].trim();
              if (!trimmed || trimmed.startsWith('#')) continue;
              const m = trimmed.match(/^([a-z_]+)\s*:\s*(.*)$/);
              if (m) props[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
            }

            const toolDef: any = {
              name: toolName,
              description: dbTool.description || props.description || '',
              tool_type: dbTool.toolType,
            };

            if (dbTool.toolType === 'http') {
              toolDef.http_binding = {
                endpoint: props.endpoint || '',
                method: (props.method || 'POST') as string,
                auth: { type: props.auth || 'none' },
              };
              const authConfigMatch = (dbTool.dslContent as string).match(
                /auth_config:\s*\n((?:\s+\w+:.*\n?)*)/,
              );
              if (authConfigMatch) {
                const configLines = authConfigMatch[1].split('\n');
                const config: Record<string, string> = {};
                for (const cl of configLines) {
                  const cm = cl.trim().match(/^(\w+)\s*:\s*(.+)$/);
                  if (cm) config[cm[1]] = cm[2].replace(/^["']|["']$/g, '').trim();
                }
                toolDef.http_binding.auth.config = {
                  headerName: config.header_name,
                  apiKey: config.api_key,
                  token: config.token,
                  provider: config.provider,
                };
              }
              if (props.timeout) toolDef.http_binding.timeout = parseInt(props.timeout, 10);

              // Extract body_template pipe block
              const bodyTemplateMatch = (dbTool.dslContent as string).match(
                /body_template:\s*\|\s*\n([\s\S]+?)(?=\n\S|\n*$)/,
              );
              if (bodyTemplateMatch) {
                toolDef.http_binding.body_template = bodyTemplateMatch[1];
              }
            } else if (dbTool.toolType === 'sandbox') {
              const codeMatch = (dbTool.dslContent as string).match(
                /code:\s*\|\s*\n([\s\S]+?)(?=\n\S|\n*$)/,
              );
              toolDef.sandbox_binding = {
                code: codeMatch ? codeMatch[1] : '',
                runtime: 'javascript',
              };
            }

            const parsedDoc = documents.find((d: any) => d.name === agentName);
            const parsedTool = parsedDoc?.tools?.find((t: any) => t.name === toolName);
            if (parsedTool?.parameters) {
              toolDef.parameters = parsedTool.parameters;
            }

            agentTools.push(toolDef);
          }
          if (agentTools.length > 0) resolvedTools.set(agentName, agentTools);
        }
      }
    }

    // Compile all agents together
    let compilationOutput: any;
    try {
      compilationOutput = compileABLtoIR(documents);
    } catch (err) {
      console.warn(
        `  Compilation failed for ${example.dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (err instanceof Error && err.stack)
        console.warn(err.stack.split('\n').slice(0, 5).join('\n'));
      continue;
    }

    const agentNames = Object.keys(compilationOutput.agents || {});
    console.log(
      `  [${example.dir}] compiled ${agentNames.length} agents: ${agentNames.slice(0, 5).join(', ')}${agentNames.length > 5 ? '...' : ''}`,
    );
    if (compilationOutput.compilation_errors?.length) {
      for (const e of compilationOutput.compilation_errors) {
        console.warn(`    Compile error: ${e.agent}: ${e.message}`);
      }
    }

    // Post-compilation: patch tool bindings
    if (resolvedTools && resolvedTools.size > 0) {
      for (const [agentName, agentTools] of resolvedTools) {
        const agentIR = compilationOutput.agents[agentName];
        if (!agentIR?.tools) continue;

        for (const resolvedTool of agentTools) {
          const irTool = agentIR.tools.find((t: any) => t.name === resolvedTool.name);
          if (!irTool) continue;
          if (resolvedTool.http_binding) irTool.http_binding = resolvedTool.http_binding;
          if (resolvedTool.sandbox_binding) irTool.sandbox_binding = resolvedTool.sandbox_binding;
          if (resolvedTool.tool_type) irTool.tool_type = resolvedTool.tool_type;
        }
      }
    }

    // Create AgentVersion for each compiled agent
    const versionManifest: Record<string, string> = {};
    const version = '0.1.0';
    let versionCount = 0;

    for (const [irName, agentIR] of Object.entries(compilationOutput.agents)) {
      const matchingDSL = agentDSLs.find(
        (a) => a.name.toLowerCase() === (irName as string).toLowerCase(),
      );
      if (!matchingDSL) continue;
      const { dsl, agentId, name: fileBasedName } = matchingDSL;

      const sourceHash = crypto
        .createHash('sha256')
        .update(dsl, 'utf8')
        .digest('hex')
        .substring(0, 16);
      const irContent = JSON.stringify({ agents: { [irName]: agentIR } });
      const versionId = `ver-${example.dir}-${fileBasedName}-${version}`;

      await upsertOne(
        AgentVersion,
        { agentId, version },
        {
          _id: versionId,
          agentId,
          version,
          status: 'active',
          dslContent: dsl,
          irContent,
          sourceHash,
          changelog: 'Seeded by seed-mongo.ts',
          createdBy: userId,
        },
        {
          status: 'active',
          dslContent: dsl,
          irContent,
          sourceHash,
        },
      );
      versionManifest[fileBasedName] = version;
      versionCount++;
    }

    if (versionCount === 0) continue;

    const compilationHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(versionManifest))
      .digest('hex')
      .substring(0, 16);

    // Create Deployment
    const deploymentId = `deploy-${example.dir}-dev`;
    const rawEntryAgent =
      projectConfig.entry_agent || compilationOutput.entry_agent || agentDSLs[0].name;
    const entryAgentMatch = agentDSLs.find(
      (a) => a.name.toLowerCase() === rawEntryAgent.toLowerCase(),
    );
    const entryAgent = entryAgentMatch?.name || rawEntryAgent;

    const endpointSlug = `${example.dir}-dev`;
    await upsertOne(
      Deployment,
      { projectId, tenantId, environment: 'dev', endpointSlug },
      {
        _id: deploymentId,
        projectId,
        tenantId,
        environment: 'dev',
        entryAgentName: entryAgent,
        agentVersionManifest: versionManifest,
        compilationHash,
        endpointSlug,
        status: 'active',
        createdBy: userId,
      },
      {
        entryAgentName: entryAgent,
        agentVersionManifest: versionManifest,
        compilationHash,
        endpointSlug,
      },
    );

    console.log(
      `  ${example.name}: ${versionCount} versions, deployment ${deploymentId} (entry: ${entryAgent})`,
    );
  }

  // =========================================================================
  // 4. Project-specific configs (tied to example projects)
  // =========================================================================
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  const defaultProvider = anthropicKey ? 'anthropic' : 'openai';
  const defaultModelId = anthropicKey ? 'claude-sonnet-4-5-20250929' : 'gpt-4o';
  const defaultModelName = anthropicKey ? 'Claude Sonnet 4.5' : 'GPT-4o';
  const defaultTenantModelFilter = anthropicKey
    ? { tenantId, displayName: 'Claude Sonnet 4.5 (Default)' }
    : openaiKey
      ? { tenantId, displayName: 'GPT-4o (Default)' }
      : null;
  const defaultTenantModel = defaultTenantModelFilter
    ? await TenantModel.findOne(defaultTenantModelFilter).select({ _id: 1 }).lean()
    : null;
  const defaultTenantModelId = defaultTenantModel
    ? String((defaultTenantModel as { _id: unknown })._id)
    : null;

  const flowTestProjectId = 'proj-flow-test';
  const flowTestProject = await Project.findOne({ _id: flowTestProjectId, tenantId }).lean();
  if (flowTestProject) {
    await upsertOne(
      ModelConfig,
      { _id: 'model-claude-sonnet' },
      {
        _id: 'model-claude-sonnet',
        name: defaultModelName,
        provider: defaultProvider,
        modelId: defaultModelId,
        projectId: flowTestProjectId,
        tenantModelId: defaultTenantModelId ?? null,
        temperature: 0.7,
        maxTokens: 4096,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        supportsTools: true,
        supportsVision: true,
        supportsStreaming: true,
        contextWindow: 200000,
        tier: 'standard',
        isDefault: true,
        priority: 1,
      },
    );
    console.log(`\nModel Config: ${defaultModelName}`);

    await upsertOne(
      ProjectLLMConfig,
      { projectId: flowTestProjectId, tenantId },
      {
        _id: 'plc-flow-test',
        tenantId,
        projectId: flowTestProjectId,
        operationTierOverrides: {},
      },
    );
    console.log('ProjectLLMConfig: proj-flow-test');

    const { ProjectSettings } = await import('./src/models/project-settings.model.js');
    await upsertOne(
      ProjectSettings,
      { projectId: flowTestProjectId, tenantId },
      {
        _id: 'ps-flow-test',
        tenantId,
        projectId: flowTestProjectId,
        enableThinking: false,
        thinkingBudget: null,
      },
    );
    console.log('ProjectSettings: proj-flow-test (enableThinking: false)');
  }
}
