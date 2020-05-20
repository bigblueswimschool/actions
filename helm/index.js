const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const required = { required: true };

function getValues(values) {
    if (!values) {
        return "{}";
    }
    if (typeof values === "object") {
        return JSON.stringify(values);
    }
    return values;
}

/**
 * Run executes the helm deployment.
 */
async function run() {
    try {
      const context = github.context;
      await status("pending");
  
      const appName = getInput("release", required);
      const namespace = getInput("namespace", required);
      const chart = `/src/charts/${getInput("chart", required)}`;
      const values = getValues(getInput("values"));
      
      core.debug(`param: release = "${release}"`);
      core.debug(`param: namespace = "${namespace}"`);
      core.debug(`param: chart = "${chart}"`);
      core.debug(`param: values = "${values}"`);
  
      // Setup command options and arguments.
      const args = [
          "list"
      ];

      process.env.HELM_HOME = "/root/.helm/"
  
      await exec.exec('helm', args);
      
    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
      await status("failure");
    }
  }
  
  run();