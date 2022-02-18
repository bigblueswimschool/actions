const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const fs = require("fs");
const util = require("util");
const readFile = util.promisify(fs.readFile);
const Handlebars = require('handlebars');
const writeFile = util.promisify(fs.writeFile);
const YAML = require('json-to-pretty-yaml');

Handlebars.registerHelper('greaterThan', (left, right, options) => {
  'use strict';
   if (left>right) {
     return options.fn(this);
  }
  return options.inverse(this);
})

const getDeployment = async (config) => {
  const { type, name, namespace, repository, version, secrets, readinessPath, apm } = config;
  const cpu = '50m';
  const memory = '256mi';
  const port = 3000;
  const replicas = 1;
  const envSecrets = secrets.split(',').map(o => o.trim())

  // Container Ports
  const containerPorts = [{ containerPort: 3000 }]
  if (type === 'nestjs') {
     containerPorts.push({ containerPort: 3001 })
  }

  // Volumes
  const volumeMounts = []
  const volumes = []

  // Load apm
  if (apm) {
    volumeMounts.push({
      "name": "elastic-apm-node",
      "mountPath": "/usr/config/elastic-apm-node.js",
      "subPath": "elastic-apm-node.js",
      "readOnly": true
    })

    volumes.push({
      "name": "elastic-apm-node",
      "secret": {
        "secretName": "elastic-apm-node"
      }
    })
  }


  // Load google cloud
  const googleIndex = envSecrets.findIndex(o => o === 'google')

  if (googleIndex >= 0) {
    volumeMounts.push({
      "name": "google-cloud",
      "mountPath": "/usr/config/google.json",
      "subPath": "googleCloud.json",
      "readOnly": true
    })

    volumes.push({
      "name": "google-cloud",
      "secret": {
         "secretName": "google-cloud"
      }
    })
  }

  console.log(volumes);

  const templateContents = await readFile('/usr/app/templates/deployment.yml.hbs');
  const template = Handlebars.compile(templateContents.toString(), { noEscape: true });
  const output = template({ ...config, envSecrets, containerPorts, cpu, memory, port, replicas, volumeMounts, volumes });
  console.log(output);

  return output;
}

const getService = async (config) => {
  const { type, name, namespace } = config;

  const ports = [
    {
      name: 'http',
      port: 3000,
      protocol: 'TCP',
      targetPort: 3000
    }
  ]

  if (type === 'nestjs') {
     ports.push({
       name: 'tcp',
       port: 3001,
       protocol: 'TCP',
       targetPort: 3001
     })
  }

  const templateContents = await readFile('/usr/app/templates/service.yml.hbs');
  const template = Handlebars.compile(templateContents.toString(), { noEscape: true });
  const output = template({ name, namespace, ports });
  return output;
}
/**
 * Input fetchers
 */
const getInputConfig = () => {
  const githubRepository = process.env.GITHUB_REPOSITORY
  const appNameInput = core.getInput('appName')
  const appName = appNameInput || githubRepository.split('/')[1]
  const apm = core.getInput('apm')
  const secrets = core.getInput('secrets')
  const namespace = core.getInput('namespace')
  const readinessPath = core.getInput('readinessPath')
  const region = core.getInput('region')
  const repository = core.getInput('repository')
  const type = core.getInput('type')
  const version = core.getInput('version')

  return {
    apm: apm || true,
    secrets: secrets || '',
    name: appName,
    namespace: namespace || 'default',
    readinessPath: readinessPath || '/info',
    region: region || null,
    repository,
    type: type || 'express',
    version
  }
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
 * getKubeCredentials() fetches the cluster credentials
 */
const getKubeCredentials = () => {
  const args = [ 'container', 'clusters', 'get-credentials' ]

  if (process.env.CLUSTER_NAME) args.push(process.env.CLUSTER_NAME)
  if (process.env.COMPUTE_ZONE) args.push('--zone', process.env.COMPUTE_ZONE)
  if (process.env.COMPUTE_REGION) args.push('--region', process.env.COMPUTE_REGION)
  if (process.env.PROJECT_ID) args.push('--project', process.env.PROJECT_ID)

  return exec.exec('gcloud', args)
}

/**
 * Run executes the helm deployment.
 */
async function run() {
    try {
      const inputConfig = getInputConfig();
      const { name, namespace, repository, type, version } = inputConfig;

      core.debug(`param: appName = "${name}"`);
      core.debug(`param: namespace = "${namespace}"`);
      core.debug(`param: repository = "${repository}"`);
      core.debug(`param: version = "${version}"`);

      // Authenticate Google Cloud
      await authGCloud()

      // Get Kube Credentials
      await getKubeCredentials()

      const args = [ 'cluster-info' ]

      await exec.exec('kubectl', args);

      const deployment = await getDeployment(inputConfig);
      await writeFile("./deployment.yml", deployment);

      const service = await getService(inputConfig);
      await writeFile("./service.yml", service);

      const deployArgs = [ 'apply', '-f', 'deployment.yml' ]
      await exec.exec('kubectl', deployArgs);

      const serviceArgs = [ 'apply', '-f', 'service.yml' ]
      await exec.exec('kubectl', serviceArgs);

    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }

  run();