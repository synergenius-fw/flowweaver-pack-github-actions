/**
 * GitHub Actions Export Target
 *
 * Generates .github/workflows/<name>.yml from a Flow Weaver CI/CD workflow.
 * No FW runtime dependency — outputs native GitHub Actions YAML.
 *
 * Mapping:
 * - FW Node → GitHub Actions step (uses: or run:)
 * - FW [job: "name"] → GitHub Actions job
 * - FW @path → job `needs:` dependencies
 * - FW @secret → ${{ secrets.NAME }}
 * - FW @cache → actions/cache@v4
 * - FW @artifact → actions/upload-artifact@v4 / actions/download-artifact@v4
 * - FW @trigger → `on:` event configuration
 */

import { stringify as yamlStringify } from 'yaml';
import type { TWorkflowAST } from '@synergenius/flow-weaver/ast';
import { isCICDWorkflow } from '@synergenius/flow-weaver/deployment';
import {
  BaseCICDTarget,
  type CICDJob,
  type CICDStep,
} from '@synergenius/flow-weaver/deployment';
import type {
  ExportOptions,
  ExportArtifacts,
  DeployInstructions,
} from '@synergenius/flow-weaver/deployment';
import { parseWorkflow } from '@synergenius/flow-weaver/api';
import * as path from 'path';

export class GitHubActionsTarget extends BaseCICDTarget {
  readonly name = 'github-actions';
  readonly description = 'GitHub Actions workflow YAML (.github/workflows/)';

  readonly deploySchema = {
    runner: { type: 'string' as const, description: 'GitHub runner label', default: 'ubuntu-latest' },
  };

  readonly nodeTypeDeploySchema = {
    action: { type: 'string' as const, description: 'GitHub Action uses: value (e.g. actions/checkout@v4)' },
    with: { type: 'string' as const, description: 'JSON object for with: parameters' },
    label: { type: 'string' as const, description: 'Step display name' },
  };

  async generate(options: ExportOptions): Promise<ExportArtifacts> {
    const filePath = path.resolve(options.sourceFile);
    const outputDir = path.resolve(options.outputDir);

    // Parse the workflow file to get AST
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
      // Build job graph
      const jobs = this.buildJobGraph(ast);

      // Resolve secrets
      this.resolveJobSecrets(jobs, ast, (name) => `\${{ secrets.${name} }}`);

      // Inject artifacts
      const artifacts = ast.options?.cicd?.artifacts || [];
      this.injectArtifactSteps(jobs, artifacts);

      // Apply cache, services, matrix from workflow options
      this.applyWorkflowOptions(jobs, ast);

      // Generate YAML
      const yamlContent = this.renderWorkflowYAML(ast, jobs);

      // Output path: .github/workflows/<name>.yml
      const yamlFileName = `.github/workflows/${ast.functionName}.yml`;
      files.push(this.createFile(outputDir, yamlFileName, yamlContent, 'config'));

      // Generate secrets doc if secrets exist
      const secrets = ast.options?.cicd?.secrets || [];
      if (secrets.length > 0) {
        const secretsDoc = this.generateSecretsDoc(secrets, 'github-actions');
        files.push(this.createFile(outputDir, 'SECRETS_SETUP.md', secretsDoc, 'other'));
      }
    }

    return {
      files,
      target: this.name,
      workflowName: options.displayName || targetWorkflows[0].name,
      entryPoint: files[0].relativePath,
    };
  }

  getDeployInstructions(_artifacts: ExportArtifacts): DeployInstructions {
    return {
      title: 'Deploy GitHub Actions Workflow',
      prerequisites: [
        'GitHub repository',
        'Repository secrets configured (see SECRETS_SETUP.md)',
      ],
      steps: [
        'Copy the .github/workflows/ directory to your repository root',
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

    // name
    doc.name = ast.name;

    // on: triggers
    doc.on = this.renderTriggers(ast.options?.cicd?.triggers || []);

    // concurrency
    if (ast.options?.cicd?.concurrency) {
      doc.concurrency = {
        group: ast.options.cicd.concurrency.group,
        'cancel-in-progress': ast.options.cicd.concurrency.cancelInProgress ?? false,
      };
    }

    // jobs
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
      // Default: manual dispatch
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
          // Tags are a filter on push
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

    // runs-on (tags override: self-hosted + tag labels)
    if (job.tags && job.tags.length > 0) {
      jobObj['runs-on'] = ['self-hosted', ...job.tags];
    } else {
      jobObj['runs-on'] = job.runner || 'ubuntu-latest';
    }

    // needs
    if (job.needs.length > 0) {
      jobObj.needs = job.needs;
    }

    // continue-on-error (from @job allow_failure)
    if (job.allowFailure) {
      jobObj['continue-on-error'] = true;
    }

    // timeout-minutes (from @job timeout, parse "30m" → 30, "1h" → 60)
    if (job.timeout) {
      jobObj['timeout-minutes'] = this.parseTimeoutMinutes(job.timeout);
    }

    // if: conditional (from @job rules)
    if (job.rules && job.rules.length > 0) {
      // Use the first rule's `if` condition, translate GitLab-style vars to GitHub context
      const condition = job.rules[0].if;
      if (condition) {
        jobObj.if = this.translateCondition(condition);
      }
    }

    // env (from @job variables or @variables)
    if (job.variables && Object.keys(job.variables).length > 0) {
      jobObj.env = { ...job.variables };
    }

    // environment
    if (job.environment) {
      const envConfig = ast.options?.cicd?.environments?.find((e) => e.name === job.environment);
      if (envConfig?.url) {
        jobObj.environment = { name: job.environment, url: envConfig.url };
      } else {
        jobObj.environment = job.environment;
      }
    }

    // matrix strategy
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

    // services
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

    // steps
    const steps: unknown[] = [];

    // Download artifacts first
    if (job.downloadArtifacts && job.downloadArtifacts.length > 0) {
      for (const artifactName of job.downloadArtifacts) {
        const artifact = ast.options?.cicd?.artifacts?.find((a) => a.name === artifactName);
        steps.push({
          uses: 'actions/download-artifact@v4',
          with: {
            name: artifactName,
            ...(artifact?.path && { path: artifact.path }),
          },
        });
      }
    }

    // Cache step
    if (job.cache) {
      steps.push(this.renderCacheStep(job.cache));
    }

    // before_script as a setup step
    if (job.beforeScript && job.beforeScript.length > 0) {
      steps.push({
        name: 'Setup',
        run: job.beforeScript.join('\n'),
      });
    }

    // Node steps
    for (const step of job.steps) {
      steps.push(this.renderStep(step));
    }

    // Upload artifacts last
    if (job.uploadArtifacts && job.uploadArtifacts.length > 0) {
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

    // reports: junit → test-reporter, coverage → codecov
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

  /**
   * Parse a timeout string like "30m", "1h", "1h30m" into minutes.
   */
  private parseTimeoutMinutes(timeout: string): number {
    let minutes = 0;
    const hourMatch = timeout.match(/(\d+)h/);
    const minMatch = timeout.match(/(\d+)m/);
    if (hourMatch) minutes += parseInt(hourMatch[1], 10) * 60;
    if (minMatch) minutes += parseInt(minMatch[1], 10);
    return minutes || 60; // default 60 if unparseable
  }

  /**
   * Translate GitLab-style CI variable conditions to GitHub Actions expressions.
   */
  private translateCondition(condition: string): string {
    return condition
      .replace(/\$CI_COMMIT_BRANCH/g, "github.ref_name")
      .replace(/\$CI_COMMIT_TAG/g, "startsWith(github.ref, 'refs/tags/')")
      .replace(/\$CI_PIPELINE_SOURCE/g, "github.event_name")
      .replace(/==/g, '==');
  }

  private renderStep(step: CICDStep): Record<string, unknown> {
    const mapping = this.resolveActionMapping(step, 'github-actions');

    if (mapping?.githubAction) {
      // Use a pre-built action
      const stepObj: Record<string, unknown> = {
        name: mapping.label || step.name,
        uses: mapping.githubAction,
      };
      if (mapping.githubWith) {
        stepObj.with = { ...mapping.githubWith };
      }
      if (step.env && Object.keys(step.env).length > 0) {
        stepObj.env = step.env;
      }
      return stepObj;
    }

    if (mapping?.gitlabScript) {
      // Known node type but no GitHub action — use run:
      const stepObj: Record<string, unknown> = {
        name: mapping.label || step.name,
        run: mapping.gitlabScript.join('\n'),
      };
      if (step.env && Object.keys(step.env).length > 0) {
        stepObj.env = step.env;
      }
      return stepObj;
    }

    // Unknown node type — generate TODO placeholder
    const stepObj: Record<string, unknown> = {
      name: step.name,
      run: `echo "TODO: Implement step '${step.id}' (node type: ${step.nodeType})"`,
    };
    if (step.env && Object.keys(step.env).length > 0) {
      stepObj.env = step.env;
    }
    return stepObj;
  }

  private renderCacheStep(cache: { strategy: string; key?: string; path?: string }): Record<string, unknown> {
    const cacheConfig: Record<string, string> = {};

    switch (cache.strategy) {
      case 'npm':
        cacheConfig.path = cache.path || '~/.npm';
        cacheConfig.key = cache.key
          ? `npm-\${{ hashFiles('${cache.key}') }}`
          : "npm-${{ hashFiles('**/package-lock.json') }}";
        break;
      case 'pip':
        cacheConfig.path = cache.path || '~/.cache/pip';
        cacheConfig.key = cache.key
          ? `pip-\${{ hashFiles('${cache.key}') }}`
          : "pip-${{ hashFiles('**/requirements.txt') }}";
        break;
      default:
        cacheConfig.path = cache.path || '.cache';
        cacheConfig.key = cache.key
          ? `${cache.strategy}-\${{ hashFiles('${cache.key}') }}`
          : `${cache.strategy}-\${{ github.sha }}`;
    }

    return {
      name: `Cache ${cache.strategy}`,
      uses: 'actions/cache@v4',
      with: cacheConfig,
    };
  }

  /**
   * Apply workflow-level options (cache, services, matrix) to jobs.
   */
  private applyWorkflowOptions(jobs: CICDJob[], ast: TWorkflowAST): void {
    const cicd = ast.options?.cicd;
    if (!cicd) return;

    // Apply cache to all jobs (or first job if only one)
    if (cicd.caches && cicd.caches.length > 0) {
      const targetJobs = jobs.length === 1 ? jobs : jobs.filter((j) => j.needs.length === 0);
      for (const job of targetJobs) {
        job.cache = cicd.caches[0]; // Primary cache
      }
    }

    // Apply services to all jobs
    if (cicd.services && cicd.services.length > 0) {
      for (const job of jobs) {
        job.services = cicd.services;
      }
    }

    // Apply matrix to first job (or specific jobs based on convention)
    if (cicd.matrix) {
      // Apply to all jobs that don't have dependencies (root jobs)
      const rootJobs = jobs.filter((j) => j.needs.length === 0);
      for (const job of rootJobs) {
        job.matrix = cicd.matrix;
      }
    }
  }
}

export default GitHubActionsTarget;
