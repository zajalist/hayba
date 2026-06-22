import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Smoke test for six material instance-layer wrapper tools:
 * - material_create
 * - material_create_instance
 * - material_set_param
 * - material_apply
 * - material_list
 * - material_get_info
 *
 * Tests that all wrappers are:
 * 1. Registered in index.ts with server.tool()
 * 2. Wired to executeCommand() calls with the correct command names (in handler files)
 * 3. Registered in the schema-registry block via reg()
 * 4. Have the correct handler exports
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8');

// As of the registrar refactor, standard tools (incl. all material_*) are
// declared ONCE in the STANDARD_DESCRIPTORS list and registered/recorded via
// loops (registerTool + recordToolSchema). A descriptor `name: 'X'` is the
// single source of truth that drives BOTH server.tool(X) and reg(X). These
// helpers accept either the legacy literal form (for un-migrated tools) or the
// descriptor form, so the tests assert the real guarantee, not a code shape.
const REGISTRAR_LOOP = /for\s*\(\s*const\s+d\s+of\s+STANDARD_DESCRIPTORS\s*\)\s*registerTool\(/;
const SCHEMA_LOOP = /for\s*\(\s*const\s+d\s+of\s+STANDARD_DESCRIPTORS\s*\)\s*recordToolSchema\(/;
/** True when `name` is registered as a tool: literal server.tool OR a descriptor consumed by the registerTool loop. */
function isToolRegistered(name: string): boolean {
  const literal = new RegExp(`server\\.tool\\(\\s*['"]${name}['"]`);
  const descriptor = new RegExp(`name:\\s*['"]${name}['"]`);
  return literal.test(indexSrc) || (descriptor.test(indexSrc) && REGISTRAR_LOOP.test(indexSrc));
}
/** True when `name`'s schema is recorded: literal reg() OR a descriptor consumed by the recordToolSchema loop. */
function isSchemaRecorded(name: string): boolean {
  const literal = new RegExp(`reg\\(\\s*['"]${name}['"]`);
  const descriptor = new RegExp(`name:\\s*['"]${name}['"]`);
  return literal.test(indexSrc) || (descriptor.test(indexSrc) && SCHEMA_LOOP.test(indexSrc));
}

// Read handler files to check for executeCommand calls
const materialCreateSrc = readFileSync(join(__dirname, 'material-create.ts'), 'utf-8');
const materialCreateInstanceSrc = readFileSync(join(__dirname, 'material-create-instance.ts'), 'utf-8');
const materialSetParamSrc = readFileSync(join(__dirname, 'material-set-param.ts'), 'utf-8');
const materialApplySrc = readFileSync(join(__dirname, 'material-apply.ts'), 'utf-8');
const materialListSrc = readFileSync(join(__dirname, 'material-list.ts'), 'utf-8');
const materialGetInfoSrc = readFileSync(join(__dirname, 'material-get-info.ts'), 'utf-8');

// Read handler files for graph-layer commands
const materialAddNodeSrc = readFileSync(join(__dirname, 'material-add-node.ts'), 'utf-8');
const materialConnectNodesSrc = readFileSync(join(__dirname, 'material-connect-nodes.ts'), 'utf-8');
const materialFunctionCreateSrc = readFileSync(join(__dirname, 'material-function-create.ts'), 'utf-8');

describe('material instance-layer wrappers', () => {
  describe('material_create', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_create')).toBe(true);
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialCreateSrc).toMatch(/executeCommand\(\s*['"]material_create['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_create')).toBe(true);
    });

    it('has package_path and name schema fields', () => {
      expect(materialCreateSrc).toMatch(/package_path:\s*z\.string\(\)/);
      expect(materialCreateSrc).toMatch(/name:\s*z\.string\(\)/);
    });
  });

  describe('material_create_instance', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_create_instance')).toBe(true);
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialCreateInstanceSrc).toMatch(/executeCommand\(\s*['"]material_create_instance['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_create_instance')).toBe(true);
    });

    it('has parent_material_path, package_path, and name schema fields', () => {
      expect(materialCreateInstanceSrc).toMatch(/parent_material_path:\s*z\.string\(\)/);
      expect(materialCreateInstanceSrc).toMatch(/package_path:\s*z\.string\(\)/);
      expect(materialCreateInstanceSrc).toMatch(/name:\s*z\.string\(\)/);
    });
  });

  describe('material_set_param', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_set_param')).toBe(true);
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialSetParamSrc).toMatch(/executeCommand\(\s*['"]material_set_param['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_set_param')).toBe(true);
    });

    it('has instance_path, param_name, and value schema fields', () => {
      expect(materialSetParamSrc).toMatch(/instance_path:\s*z\.string\(\)/);
      expect(materialSetParamSrc).toMatch(/param_name:\s*z\.string\(\)/);
      expect(materialSetParamSrc).toMatch(/value:/);
    });
  });

  describe('material_apply', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_apply')).toBe(true);
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialApplySrc).toMatch(/executeCommand\(\s*['"]material_apply['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_apply')).toBe(true);
    });

    it('has actor_id and material_path schema fields', () => {
      expect(materialApplySrc).toMatch(/actor_id:\s*z\.string\(\)/);
      expect(materialApplySrc).toMatch(/material_path:\s*z\.string\(\)/);
    });
  });

  describe('material_list', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_list')).toBe(true);
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialListSrc).toMatch(/executeCommand\(\s*['"]material_list['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_list')).toBe(true);
    });

    it('has path as optional schema field', () => {
      expect(materialListSrc).toMatch(/path:\s*z\.string\(\)\.optional\(\)/);
    });
  });

  describe('material_get_info', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_get_info')).toBe(true);
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialGetInfoSrc).toMatch(/executeCommand\(\s*['"]material_get_info['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_get_info')).toBe(true);
    });

    it('has path schema field', () => {
      expect(materialGetInfoSrc).toMatch(/path:\s*z\.string\(\)/);
    });
  });
});

/**
 * Smoke test for three material graph-layer wrapper tools:
 * - material_add_node
 * - material_connect_nodes
 * - material_function_create
 *
 * Tests that all wrappers are:
 * 1. Registered in index.ts with server.tool()
 * 2. Wired to executeCommand() calls with the correct command names (in handler files)
 * 3. Registered in the schema-registry block via reg()
 * 4. Have the correct handler exports and schemas
 */
describe('material graph-layer wrappers', () => {
  describe('material_add_node', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_add_node')).toBe(true);
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialAddNodeSrc).toMatch(/executeCommand\(\s*['"]material_add_node['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_add_node')).toBe(true);
    });

    it('has material_path and function_path optional fields', () => {
      expect(materialAddNodeSrc).toMatch(/material_path:\s*z\.string\(\)\.optional\(\)/);
      expect(materialAddNodeSrc).toMatch(/function_path:\s*z\.string\(\)\.optional\(\)/);
    });

    it('has expression_class required field with min(1)', () => {
      expect(materialAddNodeSrc).toMatch(/expression_class:\s*z\.string\(\)\.min\(1\)/);
    });

    it('has .refine for material_path or function_path', () => {
      expect(materialAddNodeSrc).toMatch(/\.refine\(\s*\(d\)\s*=>\s*!!d\.material_path\s*\|\|\s*!!d\.function_path/);
    });
  });

  describe('material_connect_nodes', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_connect_nodes')).toBe(true);
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialConnectNodesSrc).toMatch(/executeCommand\(\s*['"]material_connect_nodes['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_connect_nodes')).toBe(true);
    });

    it('has material_path and function_path optional fields', () => {
      expect(materialConnectNodesSrc).toMatch(/material_path:\s*z\.string\(\)\.optional\(\)/);
      expect(materialConnectNodesSrc).toMatch(/function_path:\s*z\.string\(\)\.optional\(\)/);
    });

    it('has from_node required field with min(1)', () => {
      expect(materialConnectNodesSrc).toMatch(/from_node:\s*z\.string\(\)\.min\(1\)/);
    });

    it('has to_node, to_input, to_property optional fields', () => {
      expect(materialConnectNodesSrc).toMatch(/to_node:\s*z\.string\(\)\.optional\(\)/);
      expect(materialConnectNodesSrc).toMatch(/to_input:\s*z\.string\(\)\.optional\(\)/);
      expect(materialConnectNodesSrc).toMatch(/to_property:\s*z\.string\(\)\.optional\(\)/);
    });

    it('has two .refine calls', () => {
      expect(materialConnectNodesSrc).toMatch(/\.refine\(\s*\(d\)\s*=>\s*!!d\.material_path\s*\|\|\s*!!d\.function_path/);
      expect(materialConnectNodesSrc).toMatch(/\.refine\(\s*\(d\)\s*=>\s*!!d\.to_node\s*\|\|\s*!!d\.to_property/);
    });
  });

  describe('material_function_create', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_function_create')).toBe(true);
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialFunctionCreateSrc).toMatch(/executeCommand\(\s*['"]material_function_create['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_function_create')).toBe(true);
    });

    it('has package_path and name required fields with min(1)', () => {
      expect(materialFunctionCreateSrc).toMatch(/package_path:\s*z\.string\(\)\.min\(1\)/);
      expect(materialFunctionCreateSrc).toMatch(/name:\s*z\.string\(\)\.min\(1\)/);
    });
  });
});

describe('material comment + named-reroute wrappers', () => {
  const addCommentSrc = readFileSync(join(__dirname, 'material-add-comment.ts'), 'utf-8');
  const rerouteDeclSrc = readFileSync(join(__dirname, 'material-add-reroute-declaration.ts'), 'utf-8');
  const rerouteUsageSrc = readFileSync(join(__dirname, 'material-add-reroute-usage.ts'), 'utf-8');

  describe('material_add_comment', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_add_comment')).toBe(true);
    });
    it('calls executeCommand with the correct command name', () => {
      expect(addCommentSrc).toMatch(/executeCommand\(\s*['"]material_add_comment['"]/);
    });
    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_add_comment')).toBe(true);
    });
    it('has a required text field', () => {
      expect(addCommentSrc).toMatch(/text:\s*z\.string\(\)/);
    });
  });

  describe('material_add_reroute_declaration', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_add_reroute_declaration')).toBe(true);
    });
    it('calls executeCommand with the correct command name', () => {
      expect(rerouteDeclSrc).toMatch(/executeCommand\(\s*['"]material_add_reroute_declaration['"]/);
    });
    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_add_reroute_declaration')).toBe(true);
    });
    it('has a required name field', () => {
      expect(rerouteDeclSrc).toMatch(/name:\s*z\.string\(\)\.min\(1\)/);
    });
  });

  describe('material_add_reroute_usage', () => {
    it('has a server.tool registration', () => {
      expect(isToolRegistered('material_add_reroute_usage')).toBe(true);
    });
    it('calls executeCommand with the correct command name', () => {
      expect(rerouteUsageSrc).toMatch(/executeCommand\(\s*['"]material_add_reroute_usage['"]/);
    });
    it('registers the schema in the eager schema-registry block', () => {
      expect(isSchemaRecorded('material_add_reroute_usage')).toBe(true);
    });
    it('has a required declaration_id field', () => {
      expect(rerouteUsageSrc).toMatch(/declaration_id:\s*z\.string\(\)\.min\(1\)/);
    });
  });
});
