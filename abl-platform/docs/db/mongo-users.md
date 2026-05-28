# MongoDB: users

### Collection: `users`

```javascript
{
  _id: String,                    // CUID
  email: String,                  // unique
  name: String | null,
  avatarUrl: String | null,
  googleId: String | null,        // unique (sparse)
  passwordHash: String | null,
  emailVerified: Boolean,         // default: false
  authProvider: String,           // "google" | "email" | "microsoft"
  createdAt: Date,
  lastLoginAt: Date | null,

  // Embedded subdocuments (1:1 with user)
  mfa: {
    encryptedSecret: String,
    verified: Boolean,
    enabledAt: Date | null,
    lastUsedAt: Date | null,
    failedAttempts: Number,       // default: 0
    lockedUntil: Date | null,
    recoveryCodes: [{
      codeHash: String,
      usedAt: Date | null,
      createdAt: Date
    }]
  } | null
}

// Indexes
{ email: 1 }                      // unique
{ googleId: 1 }                   // unique, sparse
```

### Collection: `refresh_tokens`

```javascript
{
  _id: String,                    // CUID
  token: String,                  // unique
  userId: String,                 // references users._id
  familyId: String | null,
  generation: Number,             // default: 1
  expiresAt: Date,
  createdAt: Date,
  revokedAt: Date | null
}

// Indexes
{ token: 1 }                     // unique
{ userId: 1 }
{ familyId: 1 }
{ expiresAt: 1 }                 // TTL index for auto-cleanup
```

### Collection: `email_verification_tokens`

```javascript
{
  _id: String,
  userId: String,
  token: String,                  // unique
  expiresAt: Date,
  usedAt: Date | null,
  createdAt: Date
}

// Indexes
{ token: 1 }                     // unique
{ userId: 1 }
{ expiresAt: 1 }                 // TTL index
```

### Collection: `password_reset_tokens`

```javascript
{
  _id: String,
  userId: String,
  token: String,                  // unique
  expiresAt: Date,
  usedAt: Date | null,
  createdAt: Date
}

// Indexes
{ token: 1 }                     // unique
{ userId: 1 }
{ expiresAt: 1 }                 // TTL index
```

## Notes

- MFA + RecoveryCodes are embedded in `users` document since they're 1:1 with the user and always accessed together
- Token collections get TTL indexes on `expiresAt` for automatic cleanup
- `googleId` uses a sparse unique index (allows nulls)
