# Google Cloud Migration Setup Guide

This guide covers the manual steps needed to prepare your Google Cloud Project for the `wearthistea` application.

## 1. Enable APIs
Enable the following APIs in your GCP Console:
- Cloud Run API
- Artifact Registry API
- Cloud Storage API
- Firebase Hosting API

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

## 4. Service Account & Permissions -> Avy needs to continue from here
Create a Service Account for GitHub Actions:
```bash
gcloud iam service-accounts create github-actions-deploy

# Add required roles
gcloud projects add-iam-policy-binding <PROJECT_ID> \
    --member="serviceAccount:github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/run.admin"

gcloud projects add-iam-policy-binding <PROJECT_ID> \
    --member="serviceAccount:github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/storage.admin"

gcloud projects add-iam-policy-binding <PROJECT_ID> \
    --member="serviceAccount:github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/artifactregistry.admin"

gcloud projects add-iam-policy-binding <PROJECT_ID> \
    --member="serviceAccount:github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding <PROJECT_ID> \
    --member="serviceAccount:github-actions-deploy@<PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/firebasehosting.admin"
```

Generate a JSON key for the Service Account and add it to GitHub Secrets as `GCP_SA_KEY`.

## 5. GitHub Secrets
Add the following secrets to your GitHub repository:
- `GCP_PROJECT_ID`: Your Google Cloud Project ID.
- `GCP_SA_KEY`: The JSON key for the `github-actions-deploy` service account.
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
