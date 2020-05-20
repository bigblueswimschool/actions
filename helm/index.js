const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");

/**
 * Run executes the helm deployment.
 */
async function run() {
    try {
      // const context = github.context;  
      // const appName = getInput("release", required);
      // const namespace = getInput("namespace", required);
      // const chart = `/usr/app/charts/${getInput("chart", required)}`;
      // const values = getValues(getInput("values"));
      
      // core.debug(`param: release = "${appName}"`);
      // core.debug(`param: namespace = "${namespace}"`);
      // core.debug(`param: chart = "${chart}"`);
      // core.debug(`param: values = "${values}"`);
      
      const gcloudArgs = [
        'container',
        'clusters',
        'get-credentials',
        process.env.CLUSTER_NAME,
        '--zone',
        process.env.COMPUTE_ZONE,
        '--project',
        process.env.PROJECT_ID
      ]

      await exec.exec('gcloud', gcloudArgs);
      
      // Setup command options and arguments.
      const args = [
          "list"
      ];

      process.env.HELM_HOME = "/root/.helm/"
  
      await exec.exec('helm', args);
      
    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }
  
  run();