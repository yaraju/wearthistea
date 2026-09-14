# Google Cloud Migration Setup Guide

This guide covers the manual steps needed to prepare your Google Cloud Project for the `wearthistea` application.

## 1. Enable APIs
Enable the following APIs in your GCP Console:
- Cloud Run API
- Artifact Registry API
- Cloud Storage API
- Firebase Hosting API
- IAM Service Account Credentials API (iamcredentials.googleapis.com)
- Cloud Tasks API (cloudtasks.googleapis.com) — the deploy workflow also
  enables this itself on every run, so this is a one-time head start, not
  a strict prerequisite.

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
for ROLE in run.admin storage.admin artifactregistry.admin iam.serviceAccountUser firebasehosting.admin cloudconfig.viewer iam.serviceAccountTokenCreator resourcemanager.projectViewer cloudtasks.admin serviceusage.serviceUsageAdmin; do
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
- `CLOUD_TASKS_QUEUE_EMAIL`: Cloud Tasks queue name for async email (e.g. `email`).
  The deploy workflow creates/reconciles this queue automatically — you only
  need to pick a name here.
- `CLOUD_TASKS_QUEUE_PRINTROVE`: Cloud Tasks queue name for Printrove
  product-library creation (e.g. `printrove-products`). Kept separate from
  the email queue so the two workloads can have different retry/concurrency
  tuning — see the "Ensure Cloud Tasks queues" step in `deploy.yml`. Also
  auto-created by the deploy workflow.
- `SITE_URL`: The publicly reachable base URL Cloud Tasks calls back into
  (e.g. `https://wearthistea.web.app`) — every queue's task handlers live
  under this origin.
- `TASKS_SHARED_SECRET`: Any random string (e.g. `openssl rand -hex 32`).
  Sent back by Cloud Tasks as the `X-Task-Secret` header and checked by the
  task-handler routes (`/api/tasks/*`) since Cloud Tasks can't authenticate
  as a signed-in site user. Shared across every queue.
- Design rendering (`CLOUD_TASKS_QUEUE_RENDER`) and the judge -> fix/
  regenerate -> judge validation chain (`CLOUD_TASKS_QUEUE_JUDGE`,
  `CLOUD_TASKS_QUEUE_FIX`, `CLOUD_TASKS_QUEUE_REGENERATE`, issue #13) don't
  need their own secrets — their names (`design-render`, `design-judge`,
  `design-fix`, `design-regenerate`) are literal, non-secret values
  hardcoded directly in `deploy.yml`'s "Ensure Cloud Tasks queues" step,
  auto-created/reconciled on every deploy the same way the two queues above
  are.

## 6. Cloud Run Service Account
Ensure the default Compute Engine service account (or the one used by Cloud Run) has `Storage Object Admin` permissions for the GCS bucket.

It also needs `roles/cloudtasks.enqueuer` — this is the identity Cloud Run
code actually runs as at request time (separate from `github-actions-deploy`,
which only needs queue-admin rights to *provision* the queues during deploy).
Without this role, `enqueueEmail()` / the Printrove-task equivalent will
fail to call `createTask` and — for email — fall back to sending inline;
there's no such fallback for Printrove product-library creation, so this
role is required once that queue is in use, not just nice to have.
```bash
gcloud projects add-iam-policy-binding <PROJECT_ID> \
    --member="serviceAccount:<CLOUD_RUN_RUNTIME_SA>" \
    --role="roles/cloudtasks.enqueuer"
```
