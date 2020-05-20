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

function getInput(name, options) {
  const context = github.context;
  const deployment = context.payload.deployment;
  let val = core.getInput(name.replace("_", "-"), {
    ...options,
    required: false
  });
  // if (deployment) {
  //   if (deployment[name]) val = deployment[name];
  //   if (deployment.payload[name]) val = deployment.payload[name];
  // }
  if (options && options.required && !val) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return val;
}

/**
 * Run executes the helm deployment.
 */
async function run() {
    try {
      const context = github.context;  
      const appName = getInput("release", required);
      const namespace = getInput("namespace", required);
      const chart = `/usr/app/charts/${getInput("chart", required)}`;
      const values = getValues(getInput("values"));
      
      core.debug(`param: release = "${appName}"`);
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
    }
  }
  
  run();