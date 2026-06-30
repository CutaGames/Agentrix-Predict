/**
 * Tool Registry Service
 * 
 * Central registry for all AgentrixTools. Tools auto-register via @RegisterTool()
 * or manual registration. Provides schema adapters for all LLM providers.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef, DiscoveryService } from '@nestjs/core';
import {
  AgentrixTool,
  ToolCategory,
  ToolContext,
  ToolResult,
  LLMProvider,
  ToolProgressCallback,
} from './interfaces';
import { TOOL_METADATA_KEY } from './decorators/register-tool.decorator';

@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, AgentrixTool>();

  constructor(private readonly discoveryService: DiscoveryService) {}

  async onModuleInit() {
    // Auto-discover tools decorated with @RegisterTool()
    const providers = this.discoveryService.getProviders();
    for (const wrapper of providers) {
      const instance = wrapper.instance;
      if (!instance || !instance.constructor) continue;

      const toolMeta = Reflect.getMetadata(TOOL_METADATA_KEY, instance.constructor);
      if (toolMeta && this.isAgentrixTool(instance)) {
        this.register(instance as AgentrixTool);
      }
    }

    this.logger.log(`Tool registry initialized with ${this.tools.size} tools`);
  }

  // ==========================================================
  // Registration
  // ==========================================================

  register(tool: AgentrixTool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`Tool "${tool.name}" already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  // ==========================================================
  // Lookup
  // ==========================================================

  get(name: string): AgentrixTool | undefined {
    return this.tools.get(name);
  }

  getAll(): AgentrixTool[] {
    return Array.from(this.tools.values());
  }

  getByCategory(category: ToolCategory): AgentrixTool[] {
    return this.getAll().filter((t) => t.category === category);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  // ==========================================================
  // Execution (single tool)
  // ==========================================================

  async execute(
    name: string,
    input: any,
    ctx: ToolContext,
    onProgress?: ToolProgressCallback,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Tool "${name}" not found` };
    }

    // 1. Validate input
    const parseResult = tool.inputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        success: false,
        error: `Invalid input: ${parseResult.error.issues.map((i) => i.message).join(', ')}`,
      };
    }

    // 2. Check permissions (if tool defines custom check)
    if (tool.checkPermissions) {
      const perm = await tool.checkPermissions(parseResult.data, ctx);
      if (perm.behavior === 'deny') {
        return { success: false, error: `Permission denied: ${perm.reason || 'no reason'}` };
      }
      if (perm.behavior === 'ask') {
        return { success: false, error: `Approval required: ${perm.reason || 'user approval needed'}` };
      }
    }

    // 3. Execute with timing
    const start = Date.now();
    try {
      const result = await tool.execute(parseResult.data, ctx, onProgress);
      result.durationMs = Date.now() - start;

      // 4. Truncate oversized results
      if (result.data && tool.maxResultChars) {
        const serialized = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
        if (serialized.length > tool.maxResultChars) {
          result.data = serialized.slice(0, tool.maxResultChars) + `\n...[truncated, total ${serialized.length} chars]` as any;
        }
      }

      return result;
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Tool execution failed',
        durationMs: Date.now() - start,
      };
    }
  }

  // ==========================================================
  // Schema Adapters (convert to provider-specific format)
  // ==========================================================

  getSchemasForProvider(provider: LLMProvider, filter?: { categories?: ToolCategory[] }): any[] {
    let tools = this.getAll();
    if (filter?.categories) {
      tools = tools.filter((t) => filter.categories!.includes(t.category));
    }

    switch (provider) {
      case 'claude':
        return tools.map((t) => this.toClaudeSchema(t));
      case 'openai':
        return tools.map((t) => this.toOpenAISchema(t));
      case 'gemini':
        return tools.map((t) => this.toGeminiSchema(t));
      case 'bedrock':
        return tools.map((t) => this.toBedrockSchema(t));
      default:
        return tools.map((t) => this.toClaudeSchema(t));
    }
  }

  private toClaudeSchema(tool: AgentrixTool): any {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: this.zodToJsonSchema(tool.inputSchema),
    };
  }

  private toOpenAISchema(tool: AgentrixTool): any {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.zodToJsonSchema(tool.inputSchema),
      },
    };
  }

  private toGeminiSchema(tool: AgentrixTool): any {
    return {
      name: tool.name,
      description: tool.description,
      parameters: this.zodToJsonSchema(tool.inputSchema),
    };
  }

  private toBedrockSchema(tool: AgentrixTool): any {
    return {
      toolSpec: {
        name: tool.name,
        description: tool.description,
        inputSchema: {
          json: this.zodToJsonSchema(tool.inputSchema),
        },
      },
    };
  }

  /**
   * Convert Zod schema to JSON Schema.
   * Uses zod's built-in .describe() metadata and simple introspection.
   */
  private zodToJsonSchema(schema: any): Record<string, any> {
    // If zod-to-json-schema is available, use it
    try {
      const { zodToJsonSchema } = require('zod-to-json-schema');
      // `$refStrategy: 'none'` inlines everything — without it, schemas with
      // enums/defaults/reused subtypes emit a `{ $ref, definitions }` envelope,
      // and stripping $ref/definitions below would leave a top-level object
      // with NO `type`, which Bedrock/Claude rejects:
      //   "tools.N.custom.input_schema.type: Field required"  → 400, breaking
      // ALL tool-augmented chat. Inlining avoids that entirely.
      const jsonSchema = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });
      // Remove non-LLM envelope fields.
      delete jsonSchema.$schema;
      delete jsonSchema.$ref;
      delete jsonSchema.definitions;
      // Defensive guard: Claude requires input_schema.type === 'object'.
      if (!jsonSchema.type) {
        jsonSchema.type = 'object';
        if (!jsonSchema.properties) jsonSchema.properties = {};
      }
      return jsonSchema;
    } catch {
      // Fallback: manual extraction for simple schemas
      return this.zodToJsonSchemaFallback(schema);
    }
  }

  private zodToJsonSchemaFallback(schema: any): Record<string, any> {
    if (!schema || !schema._def) {
      return { type: 'object', properties: {} };
    }
    const def = schema._def;

    if (def.typeName === 'ZodObject') {
      const properties: Record<string, any> = {};
      const required: string[] = [];
      const shape = def.shape?.() || {};

      for (const [key, val] of Object.entries(shape)) {
        properties[key] = this.zodToJsonSchemaFallback(val as any);
        if ((val as any)?._def?.typeName !== 'ZodOptional') {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }

    if (def.typeName === 'ZodString') return { type: 'string', ...(def.description ? { description: def.description } : {}) };
    if (def.typeName === 'ZodNumber') return { type: 'number', ...(def.description ? { description: def.description } : {}) };
    if (def.typeName === 'ZodBoolean') return { type: 'boolean' };
    if (def.typeName === 'ZodArray') return { type: 'array', items: this.zodToJsonSchemaFallback(def.type) };
    if (def.typeName === 'ZodEnum') return { type: 'string', enum: def.values };
    if (def.typeName === 'ZodOptional') return this.zodToJsonSchemaFallback(def.innerType);
    if (def.typeName === 'ZodDefault') return this.zodToJsonSchemaFallback(def.innerType);

    return { type: 'string' };
  }

  // ==========================================================
  // Helpers
  // ==========================================================

  private isAgentrixTool(instance: any): boolean {
    return (
      typeof instance.name === 'string' &&
      typeof instance.execute === 'function' &&
      instance.inputSchema !== undefined
    );
  }
}
