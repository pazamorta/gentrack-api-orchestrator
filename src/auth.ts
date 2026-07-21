import axios from 'axios';
import { AuthConfig } from './types';

/** Cache for OAuth2 tokens: clientId -> { token, expiresAt } */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Resolve authentication headers for a given auth configuration.
 */
export async function resolveAuthHeaders(auth: AuthConfig): Promise<Record<string, string>> {
  switch (auth.type) {
    case 'none':
      return {};

    case 'api-key': {
      const headerName = auth.headerName || 'X-API-Key';
      return { [headerName]: auth.token || '' };
    }

    case 'bearer':
      return { Authorization: `Bearer ${auth.token || ''}` };

    case 'basic': {
      const credentials = Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64');
      return { Authorization: `Basic ${credentials}` };
    }

    case 'oauth2': {
      if (!auth.oauth2) {
        throw new Error('OAuth2 config is required when auth type is oauth2');
      }
      const token = await getOAuth2Token(auth.oauth2);
      return { Authorization: `Bearer ${token}` };
    }

    default:
      return {};
  }
}

async function getOAuth2Token(config: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}): Promise<string> {
  const cacheKey = config.clientId;
  const cached = tokenCache.get(cacheKey);

  // Return cached token if still valid (with 60s buffer)
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  if (config.scope) {
    params.append('scope', config.scope);
  }

  // Send client credentials as Basic auth header (standard OAuth2 client_credentials flow)
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const response = await axios.post(config.tokenUrl, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
  });

  const { access_token, expires_in } = response.data;
  const expiresAt = Date.now() + (expires_in || 3600) * 1000;

  tokenCache.set(cacheKey, { token: access_token, expiresAt });
  return access_token;
}
