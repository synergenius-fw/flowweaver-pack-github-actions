/**
 * GitHub Actions Export Target
 *
 * Generates .github/workflows/<name>.yml from a Flow Weaver CI/CD workflow.
 * Each job runs the compiled workflow code via `node dist/<name>.cicd.js --job=<id>`,
 * with native GitHub Actions handling orchestration (triggers, dependencies,
 * runners, secrets, caches, artifacts).
 */

import { stringify as yamlStringify } from 'yaml';
import type { TWorkflowAST } from '@synergenius/flow-weaver/ast';
import {
  isCICDWorkflow,
  buildJobGraph,
  resolveJobSecrets,
  injectArtifactSteps,
  generateSecretsDoc,
  generateCICDRuntime,
  NATIVE_CI_STEPS,
  type CICDJob,
} from '@synergenius/flowweaver-pack-cicd';
import type {
  ExportOptions,
  ExportArtifacts,
  DeployInstructions,
  MultiWorkflowArtifacts,
  CompiledWorkflow,
  NodeTypeArtifacts,
  NodeTypeInfo,
  NodeTypeExportOptions,
  BundleArtifacts,
  BundleWorkflow,
  BundleNodeType,
} from '@synergenius/flow-weaver/deployment';
import { BaseExportTarget } from '@synergenius/flow-weaver/deployment';
import { parseWorkflow } from '@synergenius/flow-weaver/api';
import * as path from 'path';

export class GitHubActionsTarget extends BaseExportTarget {
  readonly name = 'github-actions';
  readonly description = 'GitHub Actions workflow YAML (.github/workflows/)';

  private _warnings: string[] = [];

  readonly deploySchema = {
    runner: { type: 'string' as const, description: 'GitHub runner label', default: 'ubuntu-latest' },
  };

  readonly nodeTypeDeploySchema = {
    action: { type: 'string' as const, description: 'GitHub Action uses: value (e.g. actions/checkout@v4)' },
    with: { type: 'string' as const, description: 'JSON object for with: parameters' },
    label: { type: 'string' as const, description: 'Step display name' },
  };

  async generate(options: ExportOptions): Promise<ExportArtifacts> {
    this._warnings = [];
    const filePath = path.resolve(options.sourceFile);
    const outputDir = path.resolve(options.outputDir);

    const parseResult = await parseWorkflow(filePath, { nodeTypesOnly: false });
    if (parseResult.errors.length > 0) {
      throw new Error(`Parse errors: ${parseResult.errors.join('; ')}`);
    }

    const allWorkflows = parseResult.allWorkflows || [];
    const targetWorkflows = options.workflowName
      ? allWorkflows.filter((w) => w.name === options.workflowName || w.functionName === options.workflowName)
      : allWorkflows.filter((w) => isCICDWorkflow(w));

    if (targetWorkflows.length === 0) {
      throw new Error('No CI/CD workflows found. Ensure workflow has CI/CD annotations (@secret, @runner, @trigger, [job:], etc.)');
    }

    const files = [];

    for (const ast of targetWorkflows) {
      const jobs = buildJobGraph(ast);
      resolveJobSecrets(jobs, ast, (name) => `\${{ secrets.${name} }}`);

      const artifacts = ast.options?.cicd?.artifacts || [];
      injectArtifactSteps(jobs, artifacts);
      this.applyWorkflowOptions(jobs, ast);

      // Generate the runtime TypeScript file that jobs will execute
      const runtimeCode = generateCICDRuntime(ast, jobs, ast.nodeTypes);
      const runtimeFileName = `src/${ast.functionName}.cicd.ts`;
      files.push(this.createFile(outputDir, runtimeFileName, runtimeCode, 'handler'));

      const yamlContent = this.renderWorkflowYAML(ast, jobs);
      const yamlFileName = `.github/workflows/${ast.functionName}.yml`;
      files.push(this.createFile(outputDir, yamlFileName, yamlContent, 'config'));

      const secrets = ast.options?.cicd?.secrets || [];
      if (secrets.length > 0) {
        const secretsDoc = generateSecretsDoc(secrets, 'github-actions');
        files.push(this.createFile(outputDir, 'SECRETS_SETUP.md', secretsDoc, 'other'));
      }
    }

    return {
      files,
      target: this.name,
      workflowName: options.displayName || targetWorkflows[0].name,
      entryPoint: files[0].relativePath,
      warnings: this._warnings.length > 0 ? this._warnings : undefined,
    };
  }

  async generateMultiWorkflow(
    _workflows: CompiledWorkflow[],
    _options: ExportOptions,
  ): Promise<MultiWorkflowArtifacts> {
    throw new Error('CI/CD targets use generate() with AST, not generateMultiWorkflow()');
  }

  async generateNodeTypeService(
    _nodeTypes: NodeTypeInfo[],
    _options: NodeTypeExportOptions,
  ): Promise<NodeTypeArtifacts> {
    throw new Error('CI/CD targets do not export node types as services');
  }

  async generateBundle(
    _workflows: BundleWorkflow[],
    _nodeTypes: BundleNodeType[],
    _options: ExportOptions,
  ): Promise<BundleArtifacts> {
    throw new Error('CI/CD targets use generate() with AST, not generateBundle()');
  }

  getDeployInstructions(_artifacts: ExportArtifacts): DeployInstructions {
    return {
      title: 'Deploy GitHub Actions Workflow',
      prerequisites: [
        'GitHub repository',
        'Repository secrets configured (see SECRETS_SETUP.md)',
      ],
      steps: [
        'Copy the .github/workflows/ directory and the generated .cicd.ts runtime to your repository',
        'Configure required secrets in GitHub (Settings > Secrets > Actions)',
        'Push to trigger the workflow',
      ],
      localTestSteps: [
        'Install act: brew install act (or see https://github.com/nektos/act)',
        'Run locally: act push',
      ],
      links: [
        { label: 'GitHub Actions Docs', url: 'https://docs.github.com/en/actions' },
        { label: 'act - Local Testing', url: 'https://github.com/nektos/act' },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Private: YAML Rendering
  // ---------------------------------------------------------------------------

  private renderWorkflowYAML(ast: TWorkflowAST, jobs: CICDJob[]): string {
    const doc: Record<string, unknown> = {};

    doc.name = ast.name;
    doc.on = this.renderTriggers(ast.options?.cicd?.triggers || []);

    if (ast.options?.cicd?.variables && Object.keys(ast.options.cicd.variables).length > 0) {
      doc.env = { ...ast.options.cicd.variables };
    }

    if (ast.options?.cicd?.includes && ast.options.cicd.includes.length > 0) {
      this._warnings.push(
        `@includes: GitHub Actions has no equivalent to GitLab CI includes. Use reusable workflows (workflow_call) or composite actions instead.`
      );
    }

    if (ast.options?.cicd?.beforeScript && ast.options.cicd.beforeScript.length > 0) {
      this._warnings.push(
        `Workflow-level @before_script: GitHub Actions has no global before_script. It has been applied per-job instead.`
      );
    }

    // Workflow-level @rule entries
    const customRules = (ast.options?.cicd as Record<string, unknown>)?.workflowRules as
      Array<{ if?: string; when?: string; changes?: string[] }> | undefined;
    if (customRules && customRules.length > 0) {
      const neverRules = customRules.filter(r => r.when === 'never' && r.if);
      const otherRules = customRules.filter(r => r.when !== 'never');

      if (neverRules.length > 0) {
        // Translate negation rules to a workflow-level `if:` condition
        const negations = neverRules.map(r => `!(${this.translateCondition(r.if!)})`);
        const existing = doc.if ? `(${doc.if}) && ` : '';
        doc.if = existing + negations.join(' && ');
      }

      for (const rule of otherRules) {
        if (rule.changes) {
          this._warnings.push(
            `@rule changes=: GitHub Actions handles path filtering via on.push.paths/paths-ignore, not workflow-level rules. Move path filters to @trigger annotations.`
          );
        }
        if (rule.when && rule.when !== 'always') {
          this._warnings.push(
            `@rule when=${rule.when}: GitHub Actions has no workflow-level "when" equivalent beyond "if:" conditions.`
          );
        }
      }
    }

    if (ast.options?.cicd?.concurrency) {
      doc.concurrency = {
        group: ast.options.cicd.concurrency.group,
        'cancel-in-progress': ast.options.cicd.concurrency.cancelInProgress ?? false,
      };
    }

    const jobsObj: Record<string, unknown> = {};
    for (const job of jobs) {
      jobsObj[job.id] = this.renderJob(job, ast);
    }
    doc.jobs = jobsObj;

    return yamlStringify(doc, {
      lineWidth: 120,
      defaultStringType: 'PLAIN',
      defaultKeyType: 'PLAIN',
    });
  }

  private renderTriggers(triggers: Array<{ type: string; branches?: string[]; paths?: string[]; pathsIgnore?: string[]; types?: string[]; cron?: string; pattern?: string; inputs?: Record<string, { description?: string; required?: boolean; default?: string; type?: string }> }>): Record<string, unknown> {
    if (triggers.length === 0) {
      return { workflow_dispatch: {} };
    }

    const on: Record<string, unknown> = {};

    for (const trigger of triggers) {
      switch (trigger.type) {
        case 'push': {
          const pushConfig: Record<string, unknown> = {};
          if (trigger.branches) pushConfig.branches = trigger.branches;
          if (trigger.paths) pushConfig.paths = trigger.paths;
          if (trigger.pathsIgnore) pushConfig['paths-ignore'] = trigger.pathsIgnore;
          on.push = Object.keys(pushConfig).length > 0 ? pushConfig : null;
          break;
        }
        case 'pull_request': {
          const prConfig: Record<string, unknown> = {};
          if (trigger.branches) prConfig.branches = trigger.branches;
          if (trigger.types) prConfig.types = trigger.types;
          if (trigger.paths) prConfig.paths = trigger.paths;
          if (trigger.pathsIgnore) prConfig['paths-ignore'] = trigger.pathsIgnore;
          on.pull_request = Object.keys(prConfig).length > 0 ? prConfig : null;
          break;
        }
        case 'schedule':
          on.schedule = on.schedule || [];
          if (trigger.cron) {
            (on.schedule as Array<{ cron: string }>).push({ cron: trigger.cron });
          }
          break;
        case 'dispatch':
          on.workflow_dispatch = trigger.inputs
            ? { inputs: trigger.inputs }
            : {};
          break;
        case 'tag': {
          if (!on.push) on.push = {};
          (on.push as Record<string, unknown>).tags = trigger.pattern
            ? [trigger.pattern]
            : ['*'];
          break;
        }
      }
    }

    return on;
  }

  private renderJob(job: CICDJob, ast: TWorkflowAST): Record<string, unknown> {
    const jobObj: Record<string, unknown> = {};

    if (job.tags && job.tags.length > 0) {
      jobObj['runs-on'] = ['self-hosted', ...job.tags];
    } else {
      jobObj['runs-on'] = job.runner || 'ubuntu-latest';
    }

    if (job.needs.length > 0) {
      jobObj.needs = job.needs;
    }

    // Optional needs: job should run even if optional deps fail
    if (job.optionalNeeds && job.optionalNeeds.length > 0) {
      jobObj.if = jobObj.if
        ? `(${jobObj.if}) || always()`
        : '${{ !cancelled() }}';
    }

    // parallel: N (render as matrix strategy)
    if (job.parallel && !job.matrix) {
      const chunks = Array.from({ length: job.parallel }, (_, i) => i + 1);
      jobObj.strategy = { matrix: { chunk: chunks } };
      this._warnings.push(
        `@job ${job.id} parallel=${job.parallel}: Rendered as strategy.matrix.chunk. The compiled workflow receives the chunk index via matrix.chunk.`
      );
    }

    if (job.allowFailure) {
      jobObj['continue-on-error'] = true;
    }

    if (job.timeout) {
      jobObj['timeout-minutes'] = this.parseTimeoutMinutes(job.timeout);
    }

    if (job.retry !== undefined && job.retry > 0) {
      this._warnings.push(
        `@job ${job.id} retry=${job.retry}: GitHub Actions has no native job-level retry. Use "Re-run failed jobs" in the UI or the nick-fields/retry action for step-level retry.`
      );
    }

    if (job.coverage) {
      this._warnings.push(
        `@job ${job.id} coverage: GitHub Actions has no native coverage regex. Use a coverage action (e.g. codecov/codecov-action) instead.`
      );
    }

    if (job.extends) {
      this._warnings.push(
        `@job ${job.id} extends="${job.extends}": GitHub Actions has no native extends. Use reusable workflows or composite actions instead.`
      );
    }

    if (job.rules && job.rules.length > 0) {
      const conditions = job.rules
        .filter(r => r.if)
        .map(r => this.translateCondition(r.if!));
      if (conditions.length === 1) {
        jobObj.if = conditions[0];
      } else if (conditions.length > 1) {
        jobObj.if = conditions.map(c => `(${c})`).join(' || ');
      }

      const hasWhen = job.rules.some(r => r.when);
      const hasChanges = job.rules.some(r => r.changes && r.changes.length > 0);
      if (hasWhen) {
        this._warnings.push(
          `@job ${job.id} rules when=: GitHub Actions has no native when (manual/delayed/always). Use workflow_dispatch for manual triggers.`
        );
      }
      if (hasChanges) {
        this._warnings.push(
          `@job ${job.id} rules changes=: GitHub Actions handles path filtering via on.push.paths, not per-job. Use dorny/paths-filter for per-job path filtering.`
        );
      }
    }

    if (job.variables && Object.keys(job.variables).length > 0) {
      jobObj.env = { ...job.variables };
    }

    if (job.environment) {
      const envConfig = ast.options?.cicd?.environments?.find((e) => e.name === job.environment);
      if (envConfig?.url) {
        jobObj.environment = { name: job.environment, url: envConfig.url };
      } else {
        jobObj.environment = job.environment;
      }
    }

    if (job.matrix) {
      const strategy: Record<string, unknown> = {};
      if (job.matrix.dimensions) {
        strategy.matrix = { ...job.matrix.dimensions };
      }
      if (job.matrix.include) {
        strategy.matrix = strategy.matrix || {};
        (strategy.matrix as Record<string, unknown>).include = job.matrix.include;
      }
      if (job.matrix.exclude) {
        strategy.matrix = strategy.matrix || {};
        (strategy.matrix as Record<string, unknown>).exclude = job.matrix.exclude;
      }
      jobObj.strategy = strategy;
    }

    if (job.services && job.services.length > 0) {
      const services: Record<string, unknown> = {};
      for (const svc of job.services) {
        const svcObj: Record<string, unknown> = { image: svc.image };
        if (svc.ports) svcObj.ports = svc.ports;
        if (svc.env) svcObj.env = svc.env;
        services[svc.name] = svcObj;
      }
      jobObj.services = services;
    }

    // Build steps: checkout, setup, install, then run compiled workflow
    const steps: unknown[] = [];

    // Download artifacts from upstream jobs
    if (!job.skipDependencies && job.needs.length > 0) {
      // Download .fw-artifacts/ from each upstream job for cross-job data transfer
      for (const depJobId of job.needs) {
        if (job.needsArtifactControl?.[depJobId] === false) continue;
        steps.push({
          uses: 'actions/download-artifact@v4',
          with: {
            name: `fw-artifacts-${depJobId}`,
            path: '.fw-artifacts/',
          },
          'continue-on-error': true,
        });
      }
    }
    if (!job.skipDependencies && job.downloadArtifacts && job.downloadArtifacts.length > 0) {
      for (const artifactName of job.downloadArtifacts) {
        // Skip download if needsArtifactControl explicitly disables it
        const depJob = artifactName.split('-')[0];
        if (job.needsArtifactControl?.[depJob] === false) continue;

        const artifact = ast.options?.cicd?.artifacts?.find((a) => a.name === artifactName);
        const portPath = job.downloadArtifactPaths?.[artifactName];
        steps.push({
          uses: 'actions/download-artifact@v4',
          with: {
            name: artifactName,
            ...(portPath ? { path: portPath } : artifact?.path ? { path: artifact.path } : {}),
          },
        });
      }

      // Load dotenv artifacts into GITHUB_ENV
      if (job.dotenvArtifacts && job.dotenvArtifacts.length > 0) {
        for (const dotenv of job.dotenvArtifacts) {
          steps.push({
            name: `Load env from ${dotenv.name}`,
            run: `cat ${dotenv.path} >> $GITHUB_ENV`,
          });
        }
      }
    }

    // Native setup: checkout
    steps.push({
      name: NATIVE_CI_STEPS.checkout.label,
      uses: NATIVE_CI_STEPS.checkout.githubAction,
    });

    // Native setup: setup-node
    steps.push({
      name: NATIVE_CI_STEPS['setup-node'].label,
      uses: NATIVE_CI_STEPS['setup-node'].githubAction,
      with: { ...NATIVE_CI_STEPS['setup-node'].githubWith },
    });

    // Cache
    if (job.cache) {
      steps.push(this.renderCacheStep(job.cache));
    }

    // Install dependencies
    steps.push({
      name: 'Install dependencies',
      run: 'npm ci',
    });

    // before_script as a setup step
    if (job.beforeScript && job.beforeScript.length > 0) {
      steps.push({
        name: 'Setup',
        run: job.beforeScript.join('\n'),
      });
    }

    // Run compiled workflow for this job (tsx executes TypeScript directly)
    const workflowBasename = ast.functionName;
    const runStep: Record<string, unknown> = {
      name: `Run ${job.name}`,
      run: `npx tsx src/${workflowBasename}.cicd.ts --job=${job.id}`,
    };

    // Merge all step-level env vars (from secret wiring) into the run step
    const mergedEnv: Record<string, string> = {};
    for (const step of job.steps) {
      if (step.env) {
        Object.assign(mergedEnv, step.env);
      }
    }
    if (Object.keys(mergedEnv).length > 0) {
      runStep.env = mergedEnv;
    }

    steps.push(runStep);

    // Upload artifacts
    if (job.uploadArtifacts && job.uploadArtifacts.length > 0) {
      // Upload .fw-artifacts for cross-job data transfer (runtime generator writes here)
      steps.push({
        uses: 'actions/upload-artifact@v4',
        with: {
          name: `fw-artifacts-${job.id}`,
          path: '.fw-artifacts/',
        },
      });

      for (const artifact of job.uploadArtifacts) {
        const uploadStep: Record<string, unknown> = {
          uses: 'actions/upload-artifact@v4',
          with: {
            name: artifact.name,
            path: artifact.path,
          },
        };
        if (artifact.retention) {
          (uploadStep.with as Record<string, unknown>)['retention-days'] = artifact.retention;
        }
        steps.push(uploadStep);
      }
    }

    // Reports
    if (job.reports && job.reports.length > 0) {
      for (const report of job.reports) {
        if (report.type === 'junit') {
          steps.push({
            name: 'Test Report',
            uses: 'dorny/test-reporter@v1',
            if: 'always()',
            with: {
              name: 'Test Results',
              path: report.path,
              reporter: 'java-junit',
            },
          });
        } else if (report.type === 'cobertura' || report.type === 'coverage') {
          steps.push({
            name: 'Upload Coverage',
            uses: 'codecov/codecov-action@v4',
            with: { files: report.path },
          });
        } else {
          steps.push({
            name: `Upload ${report.type} report`,
            uses: 'actions/upload-artifact@v4',
            with: {
              name: `${report.type}-report`,
              path: report.path,
            },
          });
        }
      }
    }

    jobObj.steps = steps;
    return jobObj;
  }

  private parseTimeoutMinutes(timeout: string): number {
    let minutes = 0;
    const hourMatch = timeout.match(/(\d+)h/);
    const minMatch = timeout.match(/(\d+)m/);
    if (hourMatch) minutes += parseInt(hourMatch[1], 10) * 60;
    if (minMatch) minutes += parseInt(minMatch[1], 10);
    return minutes || 60;
  }

  private translateCondition(condition: string): string {
    let result = condition
      .replace(/\$CI_COMMIT_BRANCH/g, "github.ref_name")
      .replace(/\$CI_COMMIT_TAG/g, "startsWith(github.ref, 'refs/tags/')")
      .replace(/\$CI_PIPELINE_SOURCE/g, "github.event_name")
      .replace(/\$CI_COMMIT_MESSAGE/g, "github.event.head_commit.message");

    // Translate GitLab regex operator: $VAR =~ /pattern/ -> contains(VAR, 'pattern')
    result = result.replace(
      /(\S+)\s*=~\s*\/([^/]+)\//g,
      (_match, variable, pattern) => `contains(${variable}, '${pattern}')`
    );

    // Translate negated regex: $VAR !~ /pattern/ -> !contains(VAR, 'pattern')
    result = result.replace(
      /(\S+)\s*!~\s*\/([^/]+)\//g,
      (_match, variable, pattern) => `!contains(${variable}, '${pattern}')`
    );

    return result;
  }

  private renderCacheStep(cache: { strategy: string; key?: string; path?: string; policy?: string; files?: string[] }): Record<string, unknown> {
    const cacheConfig: Record<string, string> = {};

    if (cache.policy) {
      this._warnings.push(
        `@cache policy="${cache.policy}": GitHub Actions cache does not support cache policy. The policy attribute is ignored.`
      );
    }

    // Build hash expression from files array or key
    const buildHashExpr = (files?: string[], key?: string, fallbackPattern?: string): string => {
      if (files && files.length > 0) {
        const filePatterns = files.map(f => `'${f}'`).join(', ');
        return `\${{ hashFiles(${filePatterns}) }}`;
      }
      if (key) return `\${{ hashFiles('${key}') }}`;
      return `\${{ hashFiles('${fallbackPattern}') }}`;
    };

    switch (cache.strategy) {
      case 'npm':
        cacheConfig.path = cache.path || '~/.npm';
        cacheConfig.key = `npm-${buildHashExpr(cache.files, cache.key, '**/package-lock.json')}`;
        break;
      case 'pip':
        cacheConfig.path = cache.path || '~/.cache/pip';
        cacheConfig.key = `pip-${buildHashExpr(cache.files, cache.key, '**/requirements.txt')}`;
        break;
      default:
        cacheConfig.path = cache.path || '.cache';
        cacheConfig.key = cache.files
          ? `${cache.strategy}-${buildHashExpr(cache.files)}`
          : cache.key
            ? `${cache.strategy}-\${{ hashFiles('${cache.key}') }}`
            : `${cache.strategy}-\${{ github.sha }}`;
    }

    return {
      name: `Cache ${cache.strategy}`,
      uses: 'actions/cache@v4',
      with: cacheConfig,
    };
  }

  private applyWorkflowOptions(jobs: CICDJob[], ast: TWorkflowAST): void {
    const cicd = ast.options?.cicd;
    if (!cicd) return;

    if (cicd.caches && cicd.caches.length > 0) {
      const targetJobs = jobs.length === 1 ? jobs : jobs.filter((j) => j.needs.length === 0);
      for (const job of targetJobs) {
        job.cache = cicd.caches[0];
      }
    }

    if (cicd.services && cicd.services.length > 0) {
      const globalServices = cicd.services.filter(s => !(s as typeof s & { job?: string }).job);
      if (globalServices.length > 0) {
        for (const job of jobs) {
          job.services = globalServices;
        }
      }
    }

    if (cicd.matrix) {
      const rootJobs = jobs.filter((j) => j.needs.length === 0);
      for (const job of rootJobs) {
        job.matrix = cicd.matrix;
      }
    }
  }
}

export default GitHubActionsTarget;
