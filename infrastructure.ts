import * as k8s from "@pulumi/kubernetes";
import * as linode from "@pulumi/linode";

// Interface for tenant configuration
interface TenantConfig {
    name: string;
    namespaceLabels?: { [key: string]: string };
    resourceQuotas?: {
        cpu: string;
        memory: string;
        pods: string;
    };
}

// Create a Linode Kubernetes Engine (LKE) cluster
const cluster = new linode.LkeCluster("multi-tenant-cluster", {
    label: "multi-tenant-cluster",
    k8sVersion: "1.28",
    region: "us-east",
    pools: [{
        type: "g6-standard-2",
        count: 3,
        autoscaler: {
            min: 3,
            max: 5,
        },
    }],
    controlPlane: {
        highAvailability: true,
    },
    tags: ["production", "multi-tenant"],
});

// Configure Kubernetes provider
const kubeconfig = cluster.kubeconfig.apply(config => {
    if (!config) throw new Error("Failed to get kubeconfig");
    return config;
});

const provider = new k8s.Provider("k8s-provider", {
    kubeconfig,
});

// Define tenant configurations
const tenants: TenantConfig[] = [
    {
        name: "tenant-a",
        namespaceLabels: { tenant: "a", environment: "production" },
        resourceQuotas: { cpu: "4", memory: "8Gi", pods: "20" },
    },
    {
        name: "tenant-b",
        namespaceLabels: { tenant: "b", environment: "production" },
        resourceQuotas: { cpu: "4", memory: "8Gi", pods: "20" },
    },
];

// Create resources for each tenant
tenants.forEach(tenant => {
    // Create namespace
    const namespace = new k8s.core.v1.Namespace(tenant.name, {
        metadata: {
            name: tenant.name,
            labels: tenant.namespaceLabels,
        },
    }, { provider });

    // Create ResourceQuota
    const quota = new k8s.core.v1.ResourceQuota(`${tenant.name}-quota`, {
        metadata: {
            namespace: tenant.name,
        },
        spec: {
            hard: {
                "limits.cpu": tenant.resourceQuotas?.cpu,
                "limits.memory": tenant.resourceQuotas?.memory,
                pods: tenant.resourceQuotas?.pods,
            },
        },
    }, { provider, dependsOn: namespace });

    // Create LimitRange for containers
    const limitRange = new k8s.core.v1.LimitRange(`${tenant.name}-limits`, {
        metadata: {
            namespace: tenant.name,
        },
        spec: {
            limits: [{
                type: "Container",
                default: {
                    cpu: "500m",
                    memory: "512Mi",
                },
                defaultRequest: {
                    cpu: "250m",
                    memory: "256Mi",
                },
                max: {
                    cpu: "2",
                    memory: "2Gi",
                },
                min: {
                    cpu: "100m",
                    memory: "64Mi",
                },
            }],
        },
    }, { provider, dependsOn: namespace });

    // Create ClusterRole for tenant
    const role = new k8s.rbac.v1.ClusterRole(`${tenant.name}-role`, {
        metadata: {
            name: `${tenant.name}-role`,
        },
        rules: [
            {
                apiGroups: [""],
                resources: ["pods", "services", "configmaps", "secrets", "persistentvolumeclaims", "serviceaccounts"],
                verbs: ["get", "list", "watch", "create", "update", "delete"],
            },
            {
                apiGroups: ["apps"],
                resources: ["deployments", "statefulsets"],
                verbs: ["get", "list", "watch", "create", "update", "delete"],
            },
            {
                apiGroups: ["networking.k8s.io"],
                resources: ["ingresses"],
                verbs: ["get", "list", "watch", "create", "update", "delete"],
            },
            {
                apiGroups: ["storage.k8s.io"],
                resources: ["storageclasses"],
                verbs: ["get", "list", "watch"],
            },
        ],
    }, { provider });

    // Create RoleBinding for tenant
    const roleBinding = new k8s.rbac.v1.RoleBinding(`${tenant.name}-rolebinding`, {
        metadata: {
            namespace: tenant.name,
        },
        roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "ClusterRole",
            name: role.metadata.name,
        },
        subjects: [{
            kind: "Group",
            name: `${tenant.name}-users`,
            apiGroup: "rbac.authorization.k8s.io",
        }],
    }, { provider, dependsOn: [namespace, role] });

    // Create NetworkPolicy
    const networkPolicy = new k8s.networking.v1.NetworkPolicy(`${tenant.name}-netpol`, {
        metadata: {
            namespace: tenant.name,
        },
        spec: {
            podSelector: {},
            policyTypes: ["Ingress", "Egress"],
            ingress: [
                {
                    // Allow ingress traffic from same namespace
                    from: [{
                        namespaceSelector: {
                            matchLabels: tenant.namespaceLabels,
                        },
                    }],
                },
                {
                    // Allow ingress traffic for WordPress
                    ports: [
                        { port: 80, protocol: "TCP" },
                        { port: 443, protocol: "TCP" },
                    ],
                    from: [{
                        namespaceSelector: {
                            matchLabels: { "kuma.io/system": "true" }
                        },
                    }],
                },
            ],
            egress: [
                {
                    // Allow egress to same namespace
                    to: [{
                        namespaceSelector: {
                            matchLabels: tenant.namespaceLabels,
                        },
                    }],
                },
                {
                    // Allow DNS resolution
                    to: [{
                        namespaceSelector: {
                            matchLabels: { "kuma.io/system": "true" }
                        },
                    }],
                    ports: [
                        { port: 53, protocol: "UDP" },
                        { port: 53, protocol: "TCP" },
                    ],
                },
                {
                    // Allow WordPress updates and external connections
                    to: [{
                        ipBlock: {
                            cidr: "0.0.0.0/0",
                            except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
                        },
                    }],
                    ports: [
                        { port: 80, protocol: "TCP" },
                        { port: 443, protocol: "TCP" },
                    ],
                },
            ],
        },
    }, { provider, dependsOn: namespace });
});

// Create Kuma namespace
const kumaNamespace = new k8s.core.v1.Namespace("kuma-system", {
    metadata: {
        name: "kuma-system",
        labels: {
            "kuma.io/system": "true",
        },
    },
}, { provider });

// Install Kuma using Helm
const kumaRelease = new k8s.helm.v3.Release("kuma", {
    chart: "kuma",
    namespace: kumaNamespace.metadata.name,
    repositoryOpts: {
        repo: "https://kumahq.github.io/charts",
    },
    version: "2.5.0",
    values: {
        controlPlane: {
            autoscaling: {
                enabled: true,
                minReplicas: 2,
                maxReplicas: 5,
            },
            resources: {
                requests: {
                    cpu: "500m",
                    memory: "512Mi",
                },
                limits: {
                    cpu: "2",
                    memory: "1Gi",
                },
            },
            tls: {
                enabled: true,
                autoGenerated: true,
            },
        },
        multizone: {
            global: {
                enabled: true,
            },
        },
        ingress: {
            enabled: true,
        },
    },
}, { provider, dependsOn: kumaNamespace });

// Create Kuma mesh policies for each tenant
tenants.forEach(tenant => {
    const meshPolicy = new k8s.apiextensions.CustomResource(`${tenant.name}-mesh-policy`, {
        apiVersion: "kuma.io/v1alpha1",
        kind: "MeshTrafficPermission",
        metadata: {
            namespace: tenant.name,
            name: `${tenant.name}-traffic-permission`,
        },
        spec: {
            targetRef: {
                kind: "Mesh",
                name: "default",
            },
            from: [{
                targetRef: {
                    kind: "MeshService",
                    name: `*`,
                },
                default: {
                    action: "ALLOW",
                },
            }],
        },
    }, { provider, dependsOn: [kumaRelease] });
});

// Export the kubeconfig to access your cluster
export const clusterKubeconfig = cluster.kubeconfig;
