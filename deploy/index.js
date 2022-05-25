const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const axios = require('axios');
const util = require("util");
const readFile = util.promisify(fs.readFile);
const Handlebars = require('handlebars');
const writeFile = util.promisify(fs.writeFile);

const cicdService = axios.create({
    baseURL: `https://api.spyglass.lessonbuddy.com/v2/cicd`,
});

const getDeployment = async (config) => {
  const { configs, cpu, image, memory, name, namespace, ports, readiness, replicas, secrets, storage, volumeMounts } = config;

  const envFrom = []
  configs.forEach((config) => envFrom.push({ type: 'configMapRef', name: config.key }))
  secrets.forEach((secret) => envFrom.push({ type: 'secretRef', name: secret.key }))

  const templateContents = await readFile('/usr/app/templates/deployment.yml.hbs');
  const template = Handlebars.compile(templateContents.toString(), { noEscape: true });
  const output = template({ cpu, envFrom, image, memory, name, namespace, ports, readiness, replicas, storage, volumeMounts });

  return output;
}

const getService = async (config) => {
  const { name, namespace, ports } = config;
  const templateContents = await readFile('/usr/app/templates/service.yml.hbs');
  const template = Handlebars.compile(templateContents.toString(), { noEscape: true });
  const output = template({ name, namespace, ports });
  return output;
}

/**
 * getConfig() fetch config from the CICD service
 */
const getConfig = async () => {
  const serviceName = core.getInput('name')
  const environmentName = core.getInput('environment')
  const imageTag = core.getInput('imageTag')
  const token = core.getInput('ghaToken')

  const response = await cicdService.post(`/gha-config`, { serviceName, environmentName, imageTag }, { headers: { Authorization: `Bearer ${token}`} }).catch(err => console.log(err));
  const config = response.data;
  return config
}

/**
 * authGCloud() activates the service account using the ENV var
 */
const authGCloud = () => {
  return exec.exec('gcloud', [
    'auth',
    'activate-service-account',
    '--key-file',
    `${process.env.GOOGLE_APPLICATION_CREDENTIALS}`
  ])
}

/**
 * getClusterCredentials() fetches the cluster credentials
 */
const getClusterCredentials = ({ name, zone, region, projectId }) => {
  const args = [ 'container', 'clusters', 'get-credentials' ]

  if (name) args.push(name)
  if (zone) args.push('--zone', zone)
  if (region) args.push('--region', region)
  if (projectId) args.push('--project', projectId)

  return exec.exec('gcloud', args)
}

/**
 * Run executes the helm deployment.
 */
async function run() {
    try {
      const config = await getConfig();
      const clusters = config.clusters;

      // Authenticate Google Cloud
      await authGCloud()

      for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        console.log(`Deploying to ${cluster.name}`)

        // Get Cluster Credentials
        await getClusterCredentials(cluster)

        const args = [ 'cluster-info' ]

        await exec.exec('kubectl', args);

        const deployment = await getDeployment(config.deployment);
        await writeFile("./deployment.yml", deployment);

        const service = await getService(config.deployment);
        await writeFile("./service.yml", service);

        const deployArgs = [ 'apply', '-f', 'deployment.yml' ]
        await exec.exec('kubectl', deployArgs);

        const serviceArgs = [ 'apply', '-f', 'service.yml' ]
        await exec.exec('kubectl', serviceArgs);
      }
    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }

  run();