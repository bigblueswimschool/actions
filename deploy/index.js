const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const fs = require("fs");
const util = require("util");
const writeFile = util.promisify(fs.writeFile);
const YAML = require('json-to-pretty-yaml');

const getDeployment = (type, name, namespace, repository, version, clusterSecrets, readinessPath, apm) => {
  const secrets = clusterSecrets.split(',').map(o => o.trim())

  const envFrom = secrets.map(o => {
    return {
      "secretRef": {
        "name": o
      }
    }
  })

  const containerPorts = [{ containerPort: 3000 }]

  if (type === 'nestjs') {
     containerPorts.push({ containerPort: 3001 })
  }

  const volumeMounts = []
  const volumes = []

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


  const googleIndex = secrets.findIndex(o === 'google')

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

  const deployment = {
    "apiVersion": "apps/v1",
    "kind": "Deployment",
    "metadata": {
       "labels": {
          "app": name
       },
       "name": name,
       "namespace": namespace
    },
    "spec": {
       "replicas": 1,
       "revisionHistoryLimit": 10,
       "selector": {
          "matchLabels": {
             "app": name
          }
       },
       "strategy": {
          "rollingUpdate": {
             "maxSurge": 2,
             "maxUnavailable": 0
          },
          "type": "RollingUpdate"
       },
       "minReadySeconds": 5,
       "template": {
          "metadata": {
             "labels": {
                "app": name
             }
          },
          "spec": {
             "containers": [
                {
                   "image": `${repository}/${name}:${version}`,
                   "imagePullPolicy": "IfNotPresent",
                   "tty": true,
                   "stdin": true,
                   "name": name,
                   "ports": containerPorts,
                   "readinessProbe": {
                      "httpGet": {
                         "path": readinessPath,
                         "port": 3000
                      },
                      initialDelaySeconds: 5,
                      periodSeconds: 5,
                      successThreshold: 1
                   },
                   "envFrom": envFrom,
                   "resources": {
                      "requests": {
                         "cpu": "50m",
                         "memory": "256Mi"
                      }
                   },
                   "volumeMounts": volumeMounts
                }
             ],
             "dnsPolicy": "ClusterFirst",
             "restartPolicy": "Always",
             "schedulerName": "default-scheduler",
             "securityContext": {},
             "terminationGracePeriodSeconds": 30,
             "volumes": volumes
          }
       }
    }
  }

  yaml = YAML.stringify(deployment)
  return yaml
}

const getService = (type, name, namespace, region) => {
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

  const service = {
    "apiVersion": "v1",
    "kind": "Service",
    "metadata": {
       "name": name,
       "namespace": namespace,
       "annotations": {
        "cloud.google.com/neg": `{ \"exposed_ports\": { \"3000\": { \"name\": \"${region}-${name}\" } } }`
       }
    },
    "spec": {
       "ports": ports,
       "selector": {
          "app": name
       },
       "type": "NodePort"
    }
  }
  yaml = YAML.stringify(service)
  return yaml
}
/**
 * Input fetchers
 */
const getAppName = () => {
  const repository = process.env.GITHUB_REPOSITORY
  const appNameInput = core.getInput('appName')
  const appName = appNameInput || repository.split('/')[1]

  return appName
}

const getApm = () => {
   const apm = core.getInput('apm')
   return apm || true
}

const getNamespace = () => {
  const namespace = core.getInput('namespace')
  return namespace || 'default'
}

const getRegion = () => {
   const region = core.getInput('region')
   return region || null
 }

const getRepository = () => {
  const repository = core.getInput('repository')
  return repository
}

const getType = () => {
   const type = core.getInput('type')
   return type || 'express'
 }

const getVersion = () => {
  const version = core.getInput('version')
  return version
}

const getClusterSecrets = () => {
  const clusterSecrets = core.getInput('clusterSecrets')
  return clusterSecrets
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
      // const context = github.context;
      const appName = getAppName()
      const clusterSecrets = getClusterSecrets();
      const namespace = getNamespace()
      const region = getRegion()
      const repository = getRepository()
      const type = getType()
      const version = getVersion()
      const apm = getApm()

      core.debug(`param: appName = "${appName}"`);
      core.debug(`param: namespace = "${namespace}"`);
      core.debug(`param: repository = "${repository}"`);
      core.debug(`param: version = "${version}"`);

      // Authenticate Google Cloud
      await authGCloud()

      // Get Kube Credentials
      await getKubeCredentials()

      const args = [ 'cluster-info' ]

      await exec.exec('kubectl', args);

      const deployment = getDeployment(type, appName, namespace, repository, version, clusterSecrets, apm);
      await writeFile("./deployment.yml", deployment);

      const service = getService(type, appName, namespace, region);
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