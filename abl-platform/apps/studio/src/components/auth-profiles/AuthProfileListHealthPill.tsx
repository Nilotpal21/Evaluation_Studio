'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  validateAuthProfile,
  validateWorkspaceAuthProfile,
  type AuthProfileSummary,
  type AuthProfileValidationResult,
} from '../../api/auth-profiles';
import { AuthProfileHealthPill, type AuthProfileHealthShape } from './AuthProfileHealthPill';

type ListHealthScope = 'project' | 'workspace';

interface AuthProfileListHealthPillProps {
  profile: AuthProfileSummary;
  scope: ListHealthScope;
  projectId?: string;
  canValidate: boolean;
}

function fallbackHealthFromProfile(
  profile: AuthProfileSummary,
  reasonOverride?: string,
): AuthProfileHealthShape {
  if (profile.status === 'revoked') {
    return {
      state: 'lifecycle_blocked',
      reason: reasonOverride ?? 'Profile has been revoked.',
    };
  }
  if (profile.status === 'expired') {
    return {
      state: 'lifecycle_blocked',
      reason: reasonOverride ?? 'Profile has expired.',
    };
  }
  if (profile.status === 'invalid') {
    return {
      state: 'lifecycle_blocked',
      reason: reasonOverride ?? 'Profile is in an invalid state.',
    };
  }

  if (profile.authType === 'oauth2_app' && profile.usageMode === 'preconfigured') {
    if (profile.status === 'active') {
      return {
        state: 'connected',
        reason:
          reasonOverride ??
          'Authorization is active. Click Verify to run a live token-health check.',
      };
    }

    if (profile.status === 'pending_authorization') {
      return {
        state: 'not_authorized',
        reason: reasonOverride ?? 'Authorization is required before this profile can be used.',
      };
    }
  }

  if (profile.authType === 'oauth2_app' && profile.usageMode !== 'preconfigured') {
    return {
      state: 'requires_user_authorization',
      reason:
        reasonOverride ??
        'Configuration is valid. Each user authorizes at runtime when the tool is invoked.',
    };
  }

  return {
    state: 'untested',
    reason:
      reasonOverride ??
      'Operational status is not available yet. Click Verify to run a live check.',
  };
}

function healthFromValidationResult(result: AuthProfileValidationResult): AuthProfileHealthShape {
  if (result.health) {
    return result.health;
  }

  if (result.valid) {
    return {
      state: 'verified',
      reason: result.message ?? 'Live verification succeeded.',
    };
  }

  return {
    state: 'configuration_error',
    reason: result.message ?? 'Live verification failed.',
  };
}

export function AuthProfileListHealthPill({
  profile,
  scope,
  projectId,
  canValidate,
}: AuthProfileListHealthPillProps) {
  const [validationResult, setValidationResult] = useState<AuthProfileValidationResult | null>(
    null,
  );
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationFailed, setVerificationFailed] = useState(false);

  useEffect(() => {
    setValidationResult(null);
    setVerificationFailed(false);
    setIsVerifying(false);
  }, [profile.id, profile.status, profile.updatedAt, profile.authType, profile.usageMode]);

  const isLegacyReadOnly = profile.migration?.status === 'legacy_read_only';
  const isLifecycleBlocked =
    profile.status === 'revoked' || profile.status === 'expired' || profile.status === 'invalid';

  const canRunLiveVerification =
    !isLegacyReadOnly && !isLifecycleBlocked && canValidate && !(scope === 'project' && !projectId);

  const handleVerify = useCallback(async () => {
    if (!canRunLiveVerification || isVerifying) return;

    setIsVerifying(true);
    setVerificationFailed(false);

    try {
      if (scope === 'workspace') {
        const response = await validateWorkspaceAuthProfile(profile.id);
        setValidationResult(response.data);
      } else {
        const response = await validateAuthProfile(projectId as string, profile.id);
        setValidationResult(response.data);
      }
    } catch {
      setVerificationFailed(true);
      setValidationResult(null);
    } finally {
      setIsVerifying(false);
    }
  }, [canRunLiveVerification, isVerifying, profile.id, projectId, scope]);

  const health = useMemo(() => {
    if (isLegacyReadOnly) {
      return fallbackHealthFromProfile(
        profile,
        'Legacy read-only profile. Live verification is not available.',
      );
    }

    if (!canValidate) {
      return fallbackHealthFromProfile(
        profile,
        'You need auth-profile:write permission to run live verification.',
      );
    }

    if (scope === 'project' && !projectId) {
      return fallbackHealthFromProfile(profile);
    }

    if (verificationFailed) {
      return fallbackHealthFromProfile(
        profile,
        'Live verification failed. Open the profile and run Verify for details.',
      );
    }

    if (validationResult) {
      return healthFromValidationResult(validationResult);
    }

    return fallbackHealthFromProfile(profile);
  }, [
    canValidate,
    isLegacyReadOnly,
    profile,
    projectId,
    scope,
    validationResult,
    verificationFailed,
  ]);

  if (!canRunLiveVerification) {
    return <AuthProfileHealthPill compact health={health} />;
  }

  return (
    <button
      type="button"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        void handleVerify();
      }}
      disabled={isVerifying}
      className="inline-flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-80"
      aria-label={
        validationResult || verificationFailed ? 'Reverify auth profile' : 'Verify auth profile'
      }
    >
      <AuthProfileHealthPill
        compact
        health={isVerifying ? undefined : health}
        fallbackLabel={isVerifying ? 'Checking…' : undefined}
      />
    </button>
  );
}
