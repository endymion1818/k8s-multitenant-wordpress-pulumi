#!/bin/bash
set -e  # Exit on error

# Set Pulumi config
echo "Setting Pulumi configuration..."
pulumi config set provider minikube

# Start Minikube
echo "Starting Minikube cluster..."
minikube start --cpus=4 --memory=8192 --kubernetes-version=v1.28.0

# Wait for Minikube to be ready
echo "Waiting for Minikube to be ready..."
minikube status

# Enable required addons
echo "Enabling required Minikube addons..."
minikube addons enable ingress
minikube addons enable storage-provisioner

# Deploy with Pulumi
echo "Deploying infrastructure with Pulumi..."
pulumi up