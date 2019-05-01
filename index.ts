import * as path from 'path'

import * as pulumi from '@pulumi/pulumi'
import * as gcp from '@pulumi/gcp'
import * as k8s from '@pulumi/kubernetes'

const name = `pulumi-gvk-repro`

const cluster = new gcp.container.Cluster(`${name}-cluster`, {
    initialNodeCount: 1,

    project: gcp.config.project,
    location: gcp.config.zone,

    nodeConfig: {
        diskType: 'pd-ssd',
        localSsdCount: 1,
        machineType: 'n1-standard-8',

        oauthScopes: [
            'https://www.googleapis.com/auth/compute',
            'https://www.googleapis.com/auth/devstorage.read_only',
            'https://www.googleapis.com/auth/logging.write',
            'https://www.googleapis.com/auth/monitoring',
        ],
    },
})

const clusterContext = pulumi
    .all([cluster.name, cluster.zone, cluster.project])
    .apply(([name, zone, project]) => `gke_${project}_${zone}_${name}`)

const kubeconfig = pulumi
    .all([clusterContext, cluster.endpoint, cluster.masterAuth])
    .apply(([context, endpoint, masterAuth]) => {
        return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${masterAuth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    auth-provider:
      config:
        cmd-args: config config-helper --format=json
        cmd-path: gcloud
        expiry-key: '{.credential.token_expiry}'
        token-key: '{.credential.access_token}'
      name: gcp
`
    })

const k8sProvider = new k8s.Provider(name, {
    kubeconfig,
})

const config = new pulumi.Config()

const clusterAdmin = new k8s.rbac.v1.ClusterRoleBinding(
    'cluster-admin-role-binding',
    {
        metadata: { name: 'cluster-admin-role-binding' },

        roleRef: {
            apiGroup: 'rbac.authorization.k8s.io',
            kind: 'ClusterRole',
            name: 'cluster-admin',
        },

        subjects: [
            {
                apiGroup: 'rbac.authorization.k8s.io',
                kind: 'User',
                name: config.require('gcloudEmail'),
            },
        ],
    },
    { provider: k8sProvider }
)

const certManager = new k8s.yaml.ConfigGroup(
    'cert-manager',
    {
        files: [
            path.join('.', 'cert-manager-0.6.0.yaml'),
            // path.join('.', 'cert-manager-0.7.2.yaml'),
        ],
    },
    {
        providers: {
            kubernetes: k8sProvider,
        },
        dependsOn: [clusterAdmin],
    }
)
