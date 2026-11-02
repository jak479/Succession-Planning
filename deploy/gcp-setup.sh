#!/usr/bin/env bash
# One-time Google Cloud setup for the hosted proof of concept. Run in Google Cloud Shell:
#   bash gcp-setup.sh <your-project-id>
# Creates: Postgres (Cloud SQL), an image registry, two service accounts (runtime, deployer), the GitHub
# identity link for deploys, and two secrets (database password, demo site password). Uses only the fictional
# sample client: do not put real client data in this project until the production steps in docs are done.
set -euo pipefail
PROJECT_ID="${1:?usage: bash gcp-setup.sh <project-id>}"
REGION="us-east1"                  # South Carolina; nearest Google region to Florida
REPO_ID="1443078919"               # GitHub repository id of jak479/Succession-Planning (immutable)
INSTANCE="oew-demo"
gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

echo "== Enabling services"
gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com secretmanager.googleapis.com

echo "== Image registry"
gcloud artifacts repositories describe oew --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create oew --repository-format=docker --location="$REGION"

echo "== Postgres 16 (smallest shared-core tier; takes several minutes)"
gcloud sql instances describe "$INSTANCE" >/dev/null 2>&1 || \
  gcloud sql instances create "$INSTANCE" --database-version=POSTGRES_16 --edition=enterprise \
    --tier=db-f1-micro --region="$REGION" --storage-size=10GB --storage-auto-increase
gcloud sql databases describe oew --instance="$INSTANCE" >/dev/null 2>&1 || gcloud sql databases create oew --instance="$INSTANCE"
DB_PASS="$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 32)"
gcloud sql users set-password postgres --instance="$INSTANCE" --password="$DB_PASS"

echo "== Secrets"
put_secret() { if gcloud secrets describe "$1" >/dev/null 2>&1; then printf %s "$2" | gcloud secrets versions add "$1" --data-file=-; else printf %s "$2" | gcloud secrets create "$1" --data-file=-; fi; }
put_secret oew-db-password "$DB_PASS"
read -r -s -p "Choose a password for the demo site (you'll type it to open the demo): " DEMO_PASS; echo
[ ${#DEMO_PASS} -ge 10 ] || { echo "Use at least 10 characters."; exit 1; }
put_secret oew-demo-password "$DEMO_PASS"

echo "== Service accounts"
RUN_SA="oew-run@${PROJECT_ID}.iam.gserviceaccount.com"; DEPLOY_SA="oew-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$RUN_SA" >/dev/null 2>&1 || gcloud iam service-accounts create oew-run --display-name="Owner exit demo: runtime"
gcloud iam service-accounts describe "$DEPLOY_SA" >/dev/null 2>&1 || gcloud iam service-accounts create oew-deploy --display-name="Owner exit demo: GitHub deployer"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$RUN_SA" --role=roles/cloudsql.client --condition=None >/dev/null
for s in oew-db-password oew-demo-password; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$RUN_SA" --role=roles/secretmanager.secretAccessor >/dev/null
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEPLOY_SA" --role=roles/run.admin --condition=None >/dev/null
gcloud artifacts repositories add-iam-policy-binding oew --location="$REGION" --member="serviceAccount:$DEPLOY_SA" --role=roles/artifactregistry.writer >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser >/dev/null

echo "== GitHub deploy link (only this repository's main branch may deploy)"
gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers describe succession-planning --location=global --workload-identity-pool=github >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc succession-planning --location=global --workload-identity-pool=github \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository_id == '${REPO_ID}' && assertion.ref == 'refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository_id/${REPO_ID}" >/dev/null

RUN_SA_ID="$(gcloud iam service-accounts describe "$RUN_SA" --format='value(uniqueId)')"
cat <<OUT

==== Done. Paste these lines back into the chat (they are identifiers, not secrets): ====
GCP_PROJECT=${PROJECT_ID}
GCP_REGION=${REGION}
GCP_WIF_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/succession-planning
GCP_DEPLOY_SA=${DEPLOY_SA}
GCP_RUN_SA=${RUN_SA}
CLOUD_SQL_INSTANCE=${PROJECT_ID}:${REGION}:${INSTANCE}

==== For the Anthropic Console (Workload identity > Connect workload > Google Cloud): ====
  service account email (claim "email"): ${RUN_SA}
  service account unique id (claim "sub"): ${RUN_SA_ID}
  audience: https://api.anthropic.com
OUT
