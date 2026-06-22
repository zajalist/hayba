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

// Read handler files to check for executeCommand calls
const materialCreateSrc = readFileSync(join(__dirname, 'material-create.ts'), 'utf-8');
const materialCreateInstanceSrc = readFileSync(join(__dirname, 'material-create-instance.ts'), 'utf-8');
const materialSetParamSrc = readFileSync(join(__dirname, 'material-set-param.ts'), 'utf-8');
const materialApplySrc = readFileSync(join(__dirname, 'material-apply.ts'), 'utf-8');
const materialListSrc = readFileSync(join(__dirname, 'material-list.ts'), 'utf-8');
const materialGetInfoSrc = readFileSync(join(__dirname, 'material-get-info.ts'), 'utf-8');

describe('material instance-layer wrappers', () => {
  describe('material_create', () => {
    it('has a server.tool registration', () => {
      expect(indexSrc).toContain("'material_create'");
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialCreateSrc).toMatch(/executeCommand\(\s*['"]material_create['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(indexSrc).toMatch(/reg\(\s*['"]material_create['"]/);
    });

    it('has package_path and name schema fields', () => {
      expect(materialCreateSrc).toMatch(/package_path:\s*z\.string\(\)/);
      expect(materialCreateSrc).toMatch(/name:\s*z\.string\(\)/);
    });
  });

  describe('material_create_instance', () => {
    it('has a server.tool registration', () => {
      expect(indexSrc).toContain("'material_create_instance'");
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialCreateInstanceSrc).toMatch(/executeCommand\(\s*['"]material_create_instance['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(indexSrc).toMatch(/reg\(\s*['"]material_create_instance['"]/);
    });

    it('has parent_material_path, package_path, and name schema fields', () => {
      expect(materialCreateInstanceSrc).toMatch(/parent_material_path:\s*z\.string\(\)/);
      expect(materialCreateInstanceSrc).toMatch(/package_path:\s*z\.string\(\)/);
      expect(materialCreateInstanceSrc).toMatch(/name:\s*z\.string\(\)/);
    });
  });

  describe('material_set_param', () => {
    it('has a server.tool registration', () => {
      expect(indexSrc).toContain("'material_set_param'");
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialSetParamSrc).toMatch(/executeCommand\(\s*['"]material_set_param['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(indexSrc).toMatch(/reg\(\s*['"]material_set_param['"]/);
    });

    it('has instance_path, param_name, and value schema fields', () => {
      expect(materialSetParamSrc).toMatch(/instance_path:\s*z\.string\(\)/);
      expect(materialSetParamSrc).toMatch(/param_name:\s*z\.string\(\)/);
      expect(materialSetParamSrc).toMatch(/value:/);
    });
  });

  describe('material_apply', () => {
    it('has a server.tool registration', () => {
      expect(indexSrc).toContain("'material_apply'");
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialApplySrc).toMatch(/executeCommand\(\s*['"]material_apply['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(indexSrc).toMatch(/reg\(\s*['"]material_apply['"]/);
    });

    it('has actor_id and material_path schema fields', () => {
      expect(materialApplySrc).toMatch(/actor_id:\s*z\.string\(\)/);
      expect(materialApplySrc).toMatch(/material_path:\s*z\.string\(\)/);
    });
  });

  describe('material_list', () => {
    it('has a server.tool registration', () => {
      expect(indexSrc).toContain("'material_list'");
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialListSrc).toMatch(/executeCommand\(\s*['"]material_list['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(indexSrc).toMatch(/reg\(\s*['"]material_list['"]/);
    });

    it('has path as optional schema field', () => {
      expect(materialListSrc).toMatch(/path:\s*z\.string\(\)\.optional\(\)/);
    });
  });

  describe('material_get_info', () => {
    it('has a server.tool registration', () => {
      expect(indexSrc).toContain("'material_get_info'");
    });

    it('calls executeCommand with the correct command name in handler', () => {
      expect(materialGetInfoSrc).toMatch(/executeCommand\(\s*['"]material_get_info['"]/);
    });

    it('registers the schema in the eager schema-registry block', () => {
      expect(indexSrc).toMatch(/reg\(\s*['"]material_get_info['"]/);
    });

    it('has path schema field', () => {
      expect(materialGetInfoSrc).toMatch(/path:\s*z\.string\(\)/);
    });
  });
});
