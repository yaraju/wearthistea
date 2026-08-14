# Google Cloud Migration Setup Guide

This guide covers the manual steps needed to prepare your Google Cloud Project for the `wearthistea` application.

## 1. Enable APIs
Enable the following APIs in your GCP Console:
- Cloud Run API
- Artifact Registry API
- Cloud Storage API
- Firebase Hosting API
- IAM Service Account Credentials API (iamcredentials.googleapis.com)

> **Note:** Ensure you have initialized Firebase in your project by visiting the [Firebase Console](https://console.firebase.google.com/), selecting your project, and clicking on "Hosting" to create the first site. The site ID should match your Project ID for the default deployment configuration.

## 2. Artifact Registry
Create a repository for your Docker images:
```bash
gcloud artifacts repositories create wearthistea \
    --repository-format=docker \
    --location=us-central1 \
    --description="Docker repository for wearthistea"
```

## 3. Cloud Storage
Create a bucket for your design artwork:
```bash
# Replace <PROJECT_ID> with your actual project ID
gsutil mb -l us-central1 gs://wearthistea-designs-<PROJECT_ID>
```

## 4. Workload Identity Federation (WIF)
We use WIF instead of JSON keys for secure authentication from GitHub Actions.

### 4.1 Enable Required API
```bash
gcloud services enable iamcredentials.googleapis.com --project="<PROJECT_ID>"
```

### 4.2 Create Service Account
```bash
gcloud iam service-accounts create github-actions-deploy \
    --display-name="GitHub Actions Deploy"

# Add required roles
for ROLE in run.admin storage.admin artifactregistry.admin iam.serviceAccountUser firebasehosting.admin cloudconfig.viewer iam.serviceAccountTokenCreator resourcemanager.projectViewer; do
  gcloud projects add-iam-policy-binding <PROJECT_ID> \
      --member="serviceAccount:github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com" \
      --role="roles/$ROLE"
done
```

### 4.3 Setup WIF Pool and Provider
```bash
# Create Workload Identity Pool
gcloud iam workload-identity-pools create "github-pool" \
    --project="<PROJECT_ID>" \
    --location="global" \
    --display-name="GitHub Actions Pool"

# Get the Pool ID
export WORKLOAD_POOL_ID=$(gcloud iam workload-identity-pools describe "github-pool" \
    --project="<PROJECT_ID>" \
    --location="global" \
    --format="value(name)")

# Create Workload Identity Provider. <OWNER/REPO> should be something like yaraju/wearthistea
gcloud iam workload-identity-pools providers create-oidc "github-provider" \
    --project="<PROJECT_ID>" \
    --location="global" \
    --workload-identity-pool="github-pool" \
    --display-name="GitHub Actions Provider" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='<OWNER/REPO>'" \
    --issuer-uri="https://token.actions.githubusercontent.com"

# Allow GitHub to impersonate the Service Account
# Replace <OWNER/REPO> with your repository (e.g., username/repo)
gcloud iam service-accounts add-iam-policy-binding "github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com" \
    --project="<PROJECT_ID>" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/${WORKLOAD_POOL_ID}/attribute.repository/<OWNER/REPO>"
```

### 4.4 Get Provider ID for GitHub Secrets
Run this to get the value for `GCP_WIF_PROVIDER`:
```bash
gcloud iam workload-identity-pools providers describe "github-provider" \
    --project="<PROJECT_ID>" \
    --location="global" \
    --workload-identity-pool="github-pool" \
    --format="value(name)"
```

## 5. GitHub Secrets
Add the following secrets to your GitHub repository:
- `GCP_PROJECT_ID`: Your Google Cloud Project ID.
- `GCP_WIF_PROVIDER`: The full name of the WIF provider (from step 4.4).
- `GCP_SA_EMAIL`: `github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com`
- `GCS_BUCKET`: The name of the bucket you created (e.g., `wearthistea-designs-<PROJECT_ID>`).
- `DATABASE_URL`: Your Neon Postgres connection string.
- `GEMINI_API_KEY`: Your Google AI Studio API key.
- `PRINT_PROVIDER`: Active fulfillment provider (`printrove` or `printify`).
- `PRINTIFY_API_TOKEN`: Your Printify API token (if using Printify).
- `PRINTIFY_SHOP_ID`: Your Printify Shop ID (if using Printify).
- `PRINTROVE_EMAIL`: Your Printrove merchant email (if using Printrove).
- `PRINTROVE_PASSWORD`: Your Printrove merchant password (if using Printrove).
- `PRINTROVE_PRODUCT_ID`: Base product ID from Printrove.
- `PRINTROVE_PRODUCT_SUBTYPE_ID`: Specific product subtype ID from Printrove.
- `PRINTROVE_VARIANT_MAP`: JSON mapping `"Color|Size"` to Printrove variant ID.
- `BASIC_AUTH_USER`: Username for the site gate.
- `BASIC_AUTH_PASSWORD`: Password for the site gate.

## 6. Cloud Run Service Account
Ensure the default Compute Engine service account (or the one used by Cloud Run) has `Storage Object Admin` permissions for the GCS bucket.
