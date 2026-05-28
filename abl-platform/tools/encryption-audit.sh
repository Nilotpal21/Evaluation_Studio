#!/usr/bin/env bash
# encryption-audit.sh — Audit the codebase for double encryption/decryption risks.
#
# Scans models, routes, services, ClickHouse stores, and queue producers
# for patterns that could cause data to be encrypted or decrypted twice.
#
# Usage: ./tools/encryption-audit.sh
# Requires: grep, perl (both available on macOS by default)

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ── Repo root ───────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

MODELS_DIR="packages/database/src/models"
TOTAL_FINDINGS=0

# Temp file to store model -> encrypted fields mapping (bash 3 compatible)
MODEL_MAP_FILE=$(mktemp)
trap 'rm -f "$MODEL_MAP_FILE"' EXIT

# ── Resolve rg ──────────────────────────────────────────────────────────
# Try to find ripgrep: user PATH, homebrew, or Claude Code vendor binary.
RG=""
if command -v rg >/dev/null 2>&1; then
  RG="rg"
else
  # Check common homebrew and cargo locations
  for candidate in \
    /opt/homebrew/bin/rg \
    /usr/local/bin/rg \
    "$HOME/.cargo/bin/rg" \
    /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/arm64-darwin/rg \
    /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/x64-darwin/rg; do
    if [[ -x "$candidate" ]]; then
      RG="$candidate"
      break
    fi
  done
fi

# Wrapper: use rg if available, fall back to grep -rE
search_files() {
  # Usage: search_files <pattern> <path...> [extra grep flags]
  local pattern="$1"
  shift
  if [[ -n "$RG" ]]; then
    "$RG" -l "$pattern" --type=ts \
      --glob='!**/node_modules/**' \
      --glob='!**/dist/**' \
      --glob='!**/.next/**' \
      "$@" 2>/dev/null || true
  else
    grep -rlE "$pattern" --include='*.ts' "$@" 2>/dev/null | \
      grep -v node_modules | grep -v '/dist/' | grep -v '\.next/' || true
  fi
}

search_lines() {
  # Usage: search_lines <pattern> <file>
  local pattern="$1"
  local file="$2"
  if [[ -n "$RG" ]]; then
    "$RG" -n "$pattern" "$file" 2>/dev/null || true
  else
    grep -nE "$pattern" "$file" 2>/dev/null || true
  fi
}

search_count() {
  # Usage: search_count <pattern> <file>
  local pattern="$1"
  local file="$2"
  if [[ -n "$RG" ]]; then
    "$RG" -c "$pattern" "$file" 2>/dev/null || echo "0"
  else
    grep -cE "$pattern" "$file" 2>/dev/null || echo "0"
  fi
}

search_quiet() {
  # Usage: search_quiet <pattern> <file>
  local pattern="$1"
  local file="$2"
  if [[ -n "$RG" ]]; then
    "$RG" -q "$pattern" "$file" 2>/dev/null
  else
    grep -qE "$pattern" "$file" 2>/dev/null
  fi
}

# ── Helpers ─────────────────────────────────────────────────────────────

header() {
  echo ""
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${CYAN}  $1${RESET}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

finding() {
  local level="$1"
  shift
  local color="$YELLOW"
  if [[ "$level" == "RISK" ]]; then
    color="$RED"
  elif [[ "$level" == "INFO" ]]; then
    color="$DIM"
  fi
  echo -e "  ${color}[$level]${RESET} $*"
  TOTAL_FINDINGS=$((TOTAL_FINDINGS + 1))
}

# ════════════════════════════════════════════════════════════════════════
# Category 1: Models with encryption plugin — identify encrypted fields
# ════════════════════════════════════════════════════════════════════════

header "Category 1: Models with encryption plugin"

cat1_count=0

while IFS= read -r model_file; do
  # Use perl for multiline extraction of fieldsToEncrypt from encryptionPlugin call.
  # Pattern: schema.plugin(encryptionPlugin, { fieldsToEncrypt: ['field1', 'field2'] })
  fields=$(perl -0777 -ne '
    while (/encryptionPlugin,\s*\{[^}]*fieldsToEncrypt:\s*\[([^\]]*)\]/gs) {
      my $raw = $1;
      my @fields = ($raw =~ /[\x27"]([^"\x27]+)[\x27"]/g);
      print join(",", @fields) . "\n";
    }
  ' "$model_file" 2>/dev/null || true)

  if [[ -z "$fields" ]]; then
    continue
  fi

  bname=$(basename "$model_file")

  # Derive the PascalCase model constant name for import matching.
  # e.g. llm-credential.model.ts -> LlmCredential
  # Also extract the actual export name from the model file for precise matching.
  model_export=$(perl -ne 'print $1 if /export\s+const\s+(\w+)\s*=/' "$model_file" 2>/dev/null | head -1 || true)
  if [[ -z "$model_export" ]]; then
    # Fallback: derive from filename
    model_export=$(echo "$bname" | sed 's/\.model\.ts$//' | perl -pe 's/(^|-)(.)/uc($2)/ge' 2>/dev/null || echo "")
  fi

  # Store in map file (tab-separated: basename<TAB>fields<TAB>exportName)
  printf '%s\t%s\t%s\n' "$bname" "$fields" "$model_export" >> "$MODEL_MAP_FILE"

  echo -e "  ${GREEN}Model:${RESET} ${BOLD}$bname${RESET}"
  echo -e "    Encrypted fields: ${CYAN}$fields${RESET}"
  cat1_count=$((cat1_count + 1))
done < <(find "$MODELS_DIR" -name '*.model.ts' -type f 2>/dev/null | sort)

if [[ $cat1_count -eq 0 ]]; then
  echo -e "  ${DIM}No models with encryptionPlugin found.${RESET}"
else
  echo ""
  echo -e "  ${DIM}Found $cat1_count models with encryption plugin.${RESET}"
fi

# ════════════════════════════════════════════════════════════════════════
# Category 2: Manual encrypt/decrypt calls on plugin-managed fields
# ════════════════════════════════════════════════════════════════════════

header "Category 2: Manual encrypt/decrypt on plugin-managed fields"

cat2_count=0

# Find files with manual encrypt/decrypt calls outside of infrastructure code
ENCRYPT_PATTERN='encryptForTenant|decryptForTenant|encryptJsonForTenant|decryptJsonForTenant'

manual_encrypt_files=""
if [[ -n "$RG" ]]; then
  manual_encrypt_files=$("$RG" -l "$ENCRYPT_PATTERN" \
    --type=ts \
    --glob='!**/node_modules/**' \
    --glob='!**/dist/**' \
    --glob='!**/.next/**' \
    --glob='!**/encryption/**' \
    --glob='!**/plugins/**' \
    --glob='!**/secure-queue.*' \
    --glob='!**/field-interceptor.*' \
    --glob='!**/engine.*' \
    --glob='!**/__tests__/**' \
    --glob='!**/docs/**' \
    --glob='!**/clickhouse-encryption-*' \
    apps/ packages/ 2>/dev/null || true)
else
  manual_encrypt_files=$(grep -rlE "$ENCRYPT_PATTERN" --include='*.ts' apps/ packages/ 2>/dev/null | \
    grep -v node_modules | grep -v '/dist/' | grep -v '\.next/' | \
    grep -v '/encryption/' | grep -v '/plugins/' | \
    grep -v 'secure-queue\.' | grep -v 'field-interceptor\.' | \
    grep -v 'engine\.' | grep -v '__tests__/' | \
    grep -v '/docs/' | grep -v 'clickhouse-encryption-' || true)
fi

if [[ -n "$manual_encrypt_files" ]]; then
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue

    # Check if this file also imports/uses a model that has the encryption plugin.
    # We match on the actual exported model constant (e.g. LLMCredential, ChannelConnection)
    # to avoid false positives from generic words like "user" or "message".
    model_refs=""
    while IFS=$'\t' read -r model_basename model_fields model_export; do
      [[ -z "$model_basename" ]] && continue
      [[ -z "$model_export" ]] && continue

      # Search for the model's exported constant name (exact word boundary via grep -w)
      if grep -qw "$model_export" "$file" 2>/dev/null; then
        model_refs="$model_refs $model_basename($model_fields)"
      fi
    done < "$MODEL_MAP_FILE"

    # Get the specific lines with encrypt/decrypt calls
    matches=$(search_lines "$ENCRYPT_PATTERN" "$file")

    if [[ -n "$model_refs" ]]; then
      finding "RISK" "${BOLD}$file${RESET}"
      echo -e "    ${RED}Manual encrypt/decrypt on file that also uses plugin-managed model(s):${RESET}"
      echo -e "    ${RED}  Models:$model_refs${RESET}"
      while IFS= read -r match; do
        [[ -z "$match" ]] && continue
        echo -e "    ${DIM}  $match${RESET}"
      done <<< "$matches"
      cat2_count=$((cat2_count + 1))
    else
      finding "INFO" "${BOLD}$file${RESET} ${DIM}(manual encrypt/decrypt, no plugin-model cross-ref)${RESET}"
      while IFS= read -r match; do
        [[ -z "$match" ]] && continue
        echo -e "    ${DIM}  $match${RESET}"
      done <<< "$matches"
    fi
  done <<< "$manual_encrypt_files"
else
  echo -e "  ${DIM}No manual encrypt/decrypt calls found outside infrastructure code.${RESET}"
fi

if [[ $cat2_count -gt 0 ]]; then
  echo ""
  echo -e "  ${RED}Found $cat2_count files with potential double-encryption risk (model + manual).${RESET}"
fi

# ════════════════════════════════════════════════════════════════════════
# Category 3: ClickHouse double-encryption risk
# ════════════════════════════════════════════════════════════════════════

header "Category 3: ClickHouse double-encryption risk"

cat3_count=0

CH_INTERCEPTOR_PATTERN='beforeInsert|afterQuery|ClickHouseEncryptionInterceptor|getClickHouseEncryptionInterceptor'
FIELD_INTERCEPT_PATTERN='encryptFields|decryptFields'

# Find files that use the ClickHouse interceptor
ch_interceptor_files=""
if [[ -n "$RG" ]]; then
  ch_interceptor_files=$("$RG" -l "$CH_INTERCEPTOR_PATTERN" \
    --type=ts \
    --glob='!**/node_modules/**' \
    --glob='!**/dist/**' \
    --glob='!**/__tests__/**' \
    --glob='!**/clickhouse-encryption-interceptor.ts' \
    --glob='!**/clickhouse-encryption-singleton.ts' \
    apps/ packages/ 2>/dev/null || true)
else
  ch_interceptor_files=$(grep -rlE "$CH_INTERCEPTOR_PATTERN" --include='*.ts' apps/ packages/ 2>/dev/null | \
    grep -v node_modules | grep -v '/dist/' | grep -v '__tests__/' | \
    grep -v 'clickhouse-encryption-interceptor\.ts' | \
    grep -v 'clickhouse-encryption-singleton\.ts' || true)
fi

# Find files that directly call encryptFields/decryptFields
direct_encrypt_files=""
if [[ -n "$RG" ]]; then
  direct_encrypt_files=$("$RG" -l "$FIELD_INTERCEPT_PATTERN" \
    --type=ts \
    --glob='!**/node_modules/**' \
    --glob='!**/dist/**' \
    --glob='!**/__tests__/**' \
    --glob='!**/field-interceptor.*' \
    --glob='!**/secure-queue.*' \
    --glob='!**/clickhouse-encryption-interceptor.ts' \
    --glob='!**/clickhouse-encryption-singleton.ts' \
    --glob='!**/encryption/index.ts' \
    apps/ packages/ 2>/dev/null || true)
else
  direct_encrypt_files=$(grep -rlE "$FIELD_INTERCEPT_PATTERN" --include='*.ts' apps/ packages/ 2>/dev/null | \
    grep -v node_modules | grep -v '/dist/' | grep -v '__tests__/' | \
    grep -v 'field-interceptor\.' | grep -v 'secure-queue\.' | \
    grep -v 'clickhouse-encryption-interceptor\.ts' | \
    grep -v 'clickhouse-encryption-singleton\.ts' | \
    grep -v 'encryption/index\.ts' || true)
fi

# Cross-reference: files that use BOTH
if [[ -n "$ch_interceptor_files" ]] && [[ -n "$direct_encrypt_files" ]]; then
  overlap=$(comm -12 <(echo "$ch_interceptor_files" | sort) <(echo "$direct_encrypt_files" | sort) 2>/dev/null || true)
  if [[ -n "$overlap" ]]; then
    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      finding "RISK" "${BOLD}$file${RESET}"
      echo -e "    ${RED}Uses BOTH ClickHouse interceptor AND direct encryptFields/decryptFields${RESET}"
      search_lines "$CH_INTERCEPTOR_PATTERN|$FIELD_INTERCEPT_PATTERN" "$file" | while IFS= read -r match; do
        echo -e "    ${DIM}  $match${RESET}"
      done
      cat3_count=$((cat3_count + 1))
    done <<< "$overlap"
  fi
fi

# Show manifest context
echo ""
echo -e "  ${BOLD}ClickHouse encryption manifest tables with encrypted fields:${RESET}"
grep -nE "fieldsToEncrypt: \['.+'\]" packages/shared/src/encryption/encryption-manifest.ts 2>/dev/null | \
  head -20 | while IFS= read -r line; do
  echo -e "    ${CYAN}$line${RESET}"
done

echo ""
echo -e "  ${BOLD}Files using the ClickHouse interceptor (beforeInsert/afterQuery):${RESET}"
if [[ -n "$ch_interceptor_files" ]]; then
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    echo -e "    ${DIM}$file${RESET}"
  done <<< "$ch_interceptor_files"
else
  echo -e "    ${DIM}None found.${RESET}"
fi

if [[ $cat3_count -eq 0 ]]; then
  echo ""
  echo -e "  ${GREEN}No ClickHouse double-encryption overlap detected.${RESET}"
else
  echo ""
  echo -e "  ${RED}Found $cat3_count files with potential ClickHouse double-encryption risk.${RESET}"
fi

# ════════════════════════════════════════════════════════════════════════
# Category 4: Secure queue double-encryption risk
# ════════════════════════════════════════════════════════════════════════

header "Category 4: Secure queue double-encryption risk"

cat4_count=0

WRAP_PATTERN='wrapJobDataForEncrypt'

wrap_files=""
if [[ -n "$RG" ]]; then
  wrap_files=$("$RG" -l "$WRAP_PATTERN" \
    --type=ts \
    --glob='!**/node_modules/**' \
    --glob='!**/dist/**' \
    --glob='!**/__tests__/**' \
    --glob='!**/secure-queue.*' \
    --glob='!**/encryption/index.ts' \
    apps/ packages/ 2>/dev/null || true)
else
  wrap_files=$(grep -rlE "$WRAP_PATTERN" --include='*.ts' apps/ packages/ 2>/dev/null | \
    grep -v node_modules | grep -v '/dist/' | grep -v '__tests__/' | \
    grep -v 'secure-queue\.' | grep -v 'encryption/index\.ts' || true)
fi

if [[ -n "$wrap_files" ]]; then
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue

    has_manual=$(search_count 'encryptForTenant|encryptJsonForTenant|encryptFields' "$file")

    if [[ "$has_manual" -gt 0 ]]; then
      finding "RISK" "${BOLD}$file${RESET}"
      echo -e "    ${RED}Calls wrapJobDataForEncrypt AND also manual encrypt in the same file${RESET}"
      search_lines 'wrapJobDataForEncrypt|encryptForTenant|encryptJsonForTenant|encryptFields' "$file" | while IFS= read -r match; do
        echo -e "    ${DIM}  $match${RESET}"
      done
      cat4_count=$((cat4_count + 1))
    else
      echo -e "  ${GREEN}OK${RESET} $file ${DIM}(wrapJobDataForEncrypt only, no manual encrypt)${RESET}"
    fi
  done <<< "$wrap_files"
else
  echo -e "  ${DIM}No files call wrapJobDataForEncrypt outside of infrastructure code.${RESET}"
fi

# Show queue manifest context
echo ""
echo -e "  ${BOLD}Redis queue encryption manifest (queues with encrypted fields):${RESET}"
grep -nE "fieldsToEncrypt: \['.+'\]" packages/shared/src/encryption/encryption-manifest.ts 2>/dev/null | \
  grep -v 'messages:' | grep -v 'traces:' | grep -v 'platform_events:' | \
  grep -v 'audit_events:' | grep -v 'insight_results:' | \
  head -20 | while IFS= read -r line; do
  echo -e "    ${CYAN}$line${RESET}"
done

if [[ $cat4_count -eq 0 ]]; then
  echo ""
  echo -e "  ${GREEN}No secure queue double-encryption risk detected.${RESET}"
else
  echo ""
  echo -e "  ${RED}Found $cat4_count files with potential queue double-encryption risk.${RESET}"
fi

# ════════════════════════════════════════════════════════════════════════
# Category 5: Double decrypt on read paths
# ════════════════════════════════════════════════════════════════════════

header "Category 5: Double decrypt on read paths (model auto-decrypt + manual decrypt)"

cat5_count=0

DECRYPT_PATTERN='decryptForTenant|decryptJsonForTenant'

decrypt_files=""
if [[ -n "$RG" ]]; then
  decrypt_files=$("$RG" -l "$DECRYPT_PATTERN" \
    --type=ts \
    --glob='!**/node_modules/**' \
    --glob='!**/dist/**' \
    --glob='!**/__tests__/**' \
    --glob='!**/encryption/**' \
    --glob='!**/plugins/**' \
    --glob='!**/engine.*' \
    --glob='!**/docs/**' \
    --glob='!**/clickhouse-encryption-*' \
    apps/ packages/ 2>/dev/null || true)
else
  decrypt_files=$(grep -rlE "$DECRYPT_PATTERN" --include='*.ts' apps/ packages/ 2>/dev/null | \
    grep -v node_modules | grep -v '/dist/' | grep -v '__tests__/' | \
    grep -v '/encryption/' | grep -v '/plugins/' | \
    grep -v 'engine\.' | grep -v '/docs/' | grep -v 'clickhouse-encryption-' || true)
fi

if [[ -n "$decrypt_files" ]]; then
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue

    # Check if file also imports/uses a Mongoose model that has auto-decrypt.
    # Match on exported model constant name for precision.
    model_refs=""
    while IFS=$'\t' read -r model_basename model_fields model_export; do
      [[ -z "$model_basename" ]] && continue
      [[ -z "$model_export" ]] && continue

      if grep -qw "$model_export" "$file" 2>/dev/null; then
        model_refs="$model_refs $model_basename($model_fields)"
      fi
    done < "$MODEL_MAP_FILE"

    if [[ -n "$model_refs" ]]; then
      finding "RISK" "${BOLD}$file${RESET}"
      echo -e "    ${RED}Manual decrypt on data potentially already auto-decrypted by model plugin${RESET}"
      echo -e "    ${RED}  Models:$model_refs${RESET}"
      search_lines "$DECRYPT_PATTERN" "$file" | while IFS= read -r match; do
        echo -e "    ${DIM}  $match${RESET}"
      done
      cat5_count=$((cat5_count + 1))
    else
      finding "INFO" "${BOLD}$file${RESET} ${DIM}(manual decrypt, no auto-decrypt model detected)${RESET}"
    fi
  done <<< "$decrypt_files"
else
  echo -e "  ${DIM}No manual decrypt calls found outside infrastructure code.${RESET}"
fi

if [[ $cat5_count -gt 0 ]]; then
  echo ""
  echo -e "  ${RED}Found $cat5_count files with potential double-decrypt risk.${RESET}"
fi

# ════════════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════════════

echo ""
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${CYAN}  Summary${RESET}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  Models with encryption plugin:         ${BOLD}$cat1_count${RESET}"
echo -e "  Cat 2 — Manual encrypt on plugin model: ${BOLD}$cat2_count${RESET} risk(s)"
echo -e "  Cat 3 — ClickHouse double-encryption:   ${BOLD}$cat3_count${RESET} risk(s)"
echo -e "  Cat 4 — Queue double-encryption:        ${BOLD}$cat4_count${RESET} risk(s)"
echo -e "  Cat 5 — Double decrypt on read:         ${BOLD}$cat5_count${RESET} risk(s)"
echo ""

total_risks=$((cat2_count + cat3_count + cat4_count + cat5_count))
echo -e "  Total findings (all categories):  ${BOLD}$TOTAL_FINDINGS${RESET}"
echo -e "  Total RISK findings:              ${BOLD}$total_risks${RESET}"

if [[ $total_risks -eq 0 ]]; then
  echo ""
  echo -e "  ${GREEN}No double-encryption/decryption risks detected.${RESET}"
else
  echo ""
  echo -e "  ${RED}$total_risks potential double-encryption/decryption risk(s) found.${RESET}"
  echo -e "  ${YELLOW}Review each RISK finding above and verify whether the manual${RESET}"
  echo -e "  ${YELLOW}encrypt/decrypt is intentional or a bug.${RESET}"
fi

echo ""
