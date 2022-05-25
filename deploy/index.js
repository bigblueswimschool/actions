const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const util = require("util");
const readFile = util.promisify(fs.readFile);
const Handlebars = require('handlebars');
const writeFile = util.promisify(fs.writeFile);

const BASE_PATH = {
  'address-nest': '/v2/address',
  'cicd-nest': '/v2/cicd'
}

const CONFIGS = {
  'address-nest': 'address-nest, auth-nest',
  'cicd-nest': 'cicd-nest, auth-nest',
}

const SECRETS = {
  'address-nest': 'apm, pgsql, google',
  'cicd-nest': 'apm, github-actions, pgsql, google',
}

const getDeployment = async (config) => {
  const { configs, type, secrets, apm } = config;
  const port = 3000;

  // Env
  const envFrom = [];
  const envConfig = configs.split(',').map(o => o.trim())
  const envSecrets = secrets.split(',').map(o => o.trim())

  envConfig.forEach((name) => envFrom.push({ type: 'configMapRef', name }))
  envSecrets.forEach((name) => envFrom.push({ type: 'secretRef', name }))

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

  const templateContents = await readFile('/usr/app/templates/deployment.yml.hbs');
  const template = Handlebars.compile(templateContents.toString(), { noEscape: true });
  const output = template({ ...config, envFrom, containerPorts, port, volumeMounts, volumes });

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

const getConfig = async () => {
  const name = core.getInput('name')
  const environment = core.getInput('environment')
  const imageTag = core.getInput('imageTag')
  const token = core.getInput('ghaToken')

  return { name, environment, imageTag, token }
}

/**
 * Input fetchers
 */
const getInputConfig = () => {
  const name = core.getInput('name')
  const basePath = BASE_PATH[name]

  // TODO: Fetch config from spyglass
  const apm = true;
  const configs = CONFIGS[name] || null;
  const cpu = '250m';
  const environment = core.getInput('environment')

  const imageTag = core.getInput('imageTag')
  const image = `gcr.io/lessonbuddy-production/${name}:${imageTag}`

  const secrets = SECRETS[name] || null;
  const namespace = environment || 'default'
  const memory = '512Mi'
  const storage = '10Mi'

  let type = 'express'
  let readinessPath = `${basePath}/info`
  if (name.substr(-4, 4) == 'nest') {
    type = 'nestjs'
    readinessPath = `${basePath}/health`
  }
  
  const replicas = environment === 'production' ? 3 : 1

  return {
    apm: apm || true,
    configs: configs || '',
    cpu: cpu || '250m',
    environment: environment || 'develop',
    image,
    name,
    namespace: namespace || 'default',
    memory: memory || '512Mi',
    readinessPath: readinessPath || '/info',
    replicas: replicas || 1,
    secrets: secrets || '',
    storage: storage || '10Mi',
    type
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
const getKubeCredentials = ({ clusterName, computeZone, computeRegion, projectId }) => {
  const args = [ 'container', 'clusters', 'get-credentials' ]

  if (clusterName) args.push(clusterName)
  if (computeZone) args.push('--zone', computeZone)
  if (computeRegion) args.push('--region', computeRegion)
  if (projectId) args.push('--project', projectId)

  return exec.exec('gcloud', args)
}

/**
 * Run executes the helm deployment.
 */
async function run() {
    try {
      const inputConfig = getInputConfig();
      const { name, environment, namespace, repository, version } = inputConfig;

      const config = await getConfig();
      console.log(config);

      // Authenticate Google Cloud
      await authGCloud()

      const clusters = []

      switch (environment) {
        case 'develop':
          clusters.push({ clusterName: 'us-central1-develop1', computeRegion: 'us-central1', projectId: 'lessonbuddy' })
          break;
        case 'production':
          clusters.push({ clusterName: 'us-central1-production1', computeRegion: 'us-central1', projectId: 'lessonbuddy-production' })
          clusters.push({ clusterName: 'us-east1-production1', computeRegion: 'us-east1', projectId: 'lessonbuddy-production' })
          break;
      }

      for (let i = 0; i < clusters.length; i++) {
        const cluster = clusters[i];
        console.log(`Deploying to ${cluster.clusterName}`)

        // Get Kube Credentials
        await getKubeCredentials(cluster)

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
      }
    } catch (error) {
      core.error(error);
      core.setFailed(error.message);
    }
  }

  run();