import { describe, it, expect } from 'vitest';
import {
  verificationEmail,
  passwordResetEmail,
  workspaceInvitationEmail,
} from '../services/email-templates.js';

describe('verificationEmail', () => {
  it('returns subject and html', () => {
    const result = verificationEmail({ verificationUrl: 'https://example.com/verify?token=abc' });
    expect(result.subject).toBe('Verify your email address');
    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('https://example.com/verify?token=abc');
  });

  it('includes personalized greeting when name provided', () => {
    const result = verificationEmail({ name: 'Alice', verificationUrl: 'https://example.com' });
    expect(result.html).toContain('Hi Alice,');
  });

  it('uses default greeting when no name', () => {
    const result = verificationEmail({ verificationUrl: 'https://example.com' });
    expect(result.html).toContain('Hi,');
    expect(result.html).not.toContain('Hi undefined');
  });

  it('includes verification code block when code provided', () => {
    const result = verificationEmail({
      verificationUrl: 'https://example.com',
      code: '123456',
    });
    expect(result.html).toContain('123456');
    expect(result.html).toContain('class="code"');
  });

  it('escapes HTML in name', () => {
    const result = verificationEmail({
      name: '<script>alert("xss")</script>',
      verificationUrl: 'https://example.com',
    });
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
  });

  it('escapes HTML in verificationUrl', () => {
    const result = verificationEmail({
      verificationUrl: 'https://example.com/verify?a=1&b=2"onclick="alert(1)',
    });
    expect(result.html).toContain('&amp;');
    expect(result.html).toContain('&quot;');
  });
});

describe('passwordResetEmail', () => {
  it('returns subject and html', () => {
    const result = passwordResetEmail({ resetUrl: 'https://example.com/reset?token=xyz' });
    expect(result.subject).toBe('Reset your password');
    expect(result.html).toContain('https://example.com/reset?token=xyz');
  });

  it('includes personalized greeting when name provided', () => {
    const result = passwordResetEmail({ name: 'Bob', resetUrl: 'https://example.com' });
    expect(result.html).toContain('Hi Bob,');
  });

  it('escapes HTML in resetUrl', () => {
    const result = passwordResetEmail({ resetUrl: 'https://example.com?a=1&b=2' });
    expect(result.html).toContain('&amp;');
  });
});

describe('workspaceInvitationEmail', () => {
  it('returns subject and html', () => {
    const result = workspaceInvitationEmail({
      inviterName: 'Alice',
      workspaceName: 'Acme Corp',
      role: 'editor',
      acceptUrl: 'https://example.com/accept',
    });
    expect(result.subject).toBe('Alice invited you to Acme Corp');
    expect(result.html).toContain('https://example.com/accept');
  });

  it('wraps inviter, workspace, and role in <strong> tags', () => {
    const result = workspaceInvitationEmail({
      inviterName: 'Alice',
      workspaceName: 'Acme',
      role: 'admin',
      acceptUrl: 'https://example.com',
    });
    expect(result.html).toContain('<strong>Alice</strong>');
    expect(result.html).toContain('<strong>Acme</strong>');
    expect(result.html).toContain('<strong>admin</strong>');
  });

  it('escapes HTML in parameters', () => {
    const result = workspaceInvitationEmail({
      inviterName: '<img src=x>',
      workspaceName: 'Acme',
      role: 'admin',
      acceptUrl: 'https://example.com',
    });
    expect(result.html).not.toContain('<img src=x>');
    expect(result.html).toContain('&lt;img src=x&gt;');
  });

  it('handles identical param values without collision', () => {
    const result = workspaceInvitationEmail({
      inviterName: 'Acme',
      workspaceName: 'Acme',
      role: 'admin',
      acceptUrl: 'https://example.com',
    });
    // Both should be wrapped in <strong> independently
    const strongCount = (result.html.match(/<strong>Acme<\/strong>/g) || []).length;
    expect(strongCount).toBe(2);
  });
});
