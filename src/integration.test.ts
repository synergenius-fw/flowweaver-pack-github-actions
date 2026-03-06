import { describe, it, expect } from 'vitest';
import { GitHubActionsTarget } from './target.js';
import { buildJobGraph } from '@synergenius/flowweaver-pack-cicd';
import type { TWorkflowAST, TNodeTypeAST } from '@synergenius/flow-weaver/ast';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeNodeType(
  name: string,
  inputs: Record<string, any> = {},
  outputs: Record<string, any> = {},
  overrides: Partial<TNodeTypeAST> = {},
): TNodeTypeAST {
  return {
    type: 'NodeType',
    name,
    functionName: name,
    inputs,
    outputs,
    hasSuccessPort: false,
    hasFailurePort: false,
    executeWhen: 'ANY_INPUT',
    isAsync: false,
    expression: true,
    ...overrides,
  } as TNodeTypeAST;
}

// ---------------------------------------------------------------------------
// Multi-job fixture: build → deploy
// ---------------------------------------------------------------------------

const npmBuildNt = makeNodeType(
  'npmBuild',
  { cwd: { dataType: 'string', default: '.' } },
  { output: { dataType: 'string' } },
);

const deploySshNt = makeNodeType(
  'deploySsh',
  { sourcePath: { dataType: 'string' } },
  { result: { dataType: 'string' } },
);

const allNodeTypes = [npmBuildNt, deploySshNt];

const ast: TWorkflowAST = {
  name: 'BuildAndDeploy',
  functionName: 'buildAndDeploy',
  nodeTypes: allNodeTypes,
  instances: [
    { id: 'build1', nodeType: 'npmBuild', job: 'build' } as any,
    { id: 'deploy1', nodeType: 'deploySsh', job: 'deploy' } as any,
  ],
  connections: [
    { from: { node: 'build1', port: 'output' }, to: { node: 'deploy1', port: 'sourcePath' } } as any,
  ],
  options: { cicd: {} },
  startPorts: {},
  exitPorts: {},
} as TWorkflowAST;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitHub Actions integration', () => {
  const jobs = buildJobGraph(ast);
  const target = new GitHubActionsTarget();
  const yaml = (target as any).renderWorkflowYAML(ast, jobs);

  it('renders YAML with jobs block containing both jobs', () => {
    expect(yaml).toContain('jobs:');
    expect(yaml).toContain('build:');
    expect(yaml).toContain('deploy:');
  });

  it('includes checkout and setup-node steps', () => {
    expect(yaml).toContain('actions/checkout@v4');
    expect(yaml).toContain('actions/setup-node@v4');
  });

  it('includes job run command per job', () => {
    expect(yaml).toContain('buildAndDeploy.cicd.');
    expect(yaml).toContain('--job=build');
    expect(yaml).toContain('--job=deploy');
  });

  it('sets deploy job needs to build', () => {
    expect(yaml).toContain('needs:');
  });
});
