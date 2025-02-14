"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.kubeconfig = void 0;
const k8s = __importStar(require("@pulumi/kubernetes"));
const linode = __importStar(require("@pulumi/linode"));
const pulumi = __importStar(require("@pulumi/pulumi"));
// Initialize Pulumi Config
const config = new pulumi.Config();
const targetProvider = config.require("provider");
if (targetProvider !== "minikube" && targetProvider !== "linode") {
    throw new Error('Provider must be either "minikube" or "linode"');
}
// Cluster and provider configuration based on selected provider
let k8sProvider;
let clusterKubeconfig;
if (targetProvider === "linode") {
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
    const kubeconfig = cluster.kubeconfig.apply(config => {
        if (!config)
            throw new Error("Failed to get kubeconfig");
        return config;
    });
    k8sProvider = new k8s.Provider("k8s-provider", {
        kubeconfig,
    });
    clusterKubeconfig = cluster.kubeconfig;
}
else {
    // Use local minikube configuration
    k8sProvider = new k8s.Provider("k8s-provider", {});
}
// Define tenant configurations
const tenants = [
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
    var _a, _b, _c, _d, _e, _f;
    // Create namespace
    const namespace = new k8s.core.v1.Namespace(tenant.name, {
        metadata: {
            name: tenant.name,
            labels: tenant.namespaceLabels,
        },
    }, { provider: k8sProvider });
    // Create ResourceQuota
    const quota = new k8s.core.v1.ResourceQuota(`${tenant.name}-quota`, {
        metadata: {
            namespace: tenant.name,
        },
        spec: {
            hard: {
                "limits.cpu": (_b = (_a = tenant.resourceQuotas) === null || _a === void 0 ? void 0 : _a.cpu) !== null && _b !== void 0 ? _b : "0",
                "limits.memory": (_d = (_c = tenant.resourceQuotas) === null || _c === void 0 ? void 0 : _c.memory) !== null && _d !== void 0 ? _d : "0",
                pods: (_f = (_e = tenant.resourceQuotas) === null || _e === void 0 ? void 0 : _e.pods) !== null && _f !== void 0 ? _f : "0",
            },
        },
    }, { provider: k8sProvider, dependsOn: namespace });
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
    }, { provider: k8sProvider, dependsOn: namespace });
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
    }, { provider: k8sProvider, dependsOn: namespace });
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
    }, { provider: k8sProvider, dependsOn: [namespace, role] });
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
    }, { provider: k8sProvider, dependsOn: namespace });
});
// Create Kuma namespace
const kumaNamespace = new k8s.core.v1.Namespace("kuma-system", {
    metadata: {
        name: "kuma-system",
        labels: {
            "kuma.io/system": "true",
        },
    },
}, { provider: k8sProvider });
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
                enabled: targetProvider === "linode",
                minReplicas: targetProvider === "linode" ? 2 : 1,
                maxReplicas: targetProvider === "linode" ? 5 : 1,
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
}, { provider: k8sProvider, dependsOn: kumaNamespace });
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
    }, { provider: k8sProvider, dependsOn: [kumaRelease] });
});
// Export the kubeconfig for Linode cluster only
exports.kubeconfig = clusterKubeconfig;
//# sourceMappingURL=infrastructure.js.map