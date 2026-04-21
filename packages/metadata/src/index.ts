import crypto from 'node:crypto';

export class MetadataClient {
  private baseUrl: string;
  private owner: string;
  private secret: string;
  private alias: string;

  constructor() {
    this.baseUrl = (process.env.METADATA_URL || 'http://metadata:21001').replace(/\/$/, '');
    this.owner = process.env.OWNER || '';
    this.secret = process.env.SESSION_SECRET || '';
    this.alias = process.env.X_REQUEST_ALIAS || '';
  }

  private base64url(str: string | Buffer): string {
    return (typeof str === 'string' ? Buffer.from(str) : str)
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  }

  private generateJWT(path: string): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      OWNER: this.owner,
      iat: Math.floor(Date.now() / 1000),
      path: path,
    };

    const encodedHeader = this.base64url(JSON.stringify(header));
    const encodedPayload = this.base64url(JSON.stringify(payload));
    const signatureInput = `${encodedHeader}.${encodedPayload}`;

    const hmac = crypto.createHmac('sha256', this.secret);
    const signature = hmac.update(signatureInput).digest();
    const encodedSignature = this.base64url(signature);

    return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
  }

  async request<T>(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: any
  ): Promise<T | null> {
    const fullPath = path.startsWith('/') ? path : `/${path}`;
    let url = `${this.baseUrl}${fullPath}`;

    if (params) {
      const query = new URLSearchParams(params).toString();
      if (query) {
        url = `${url}?${query}`;
      }
    }

    const token = this.generateJWT(fullPath);

    try {
      const headers: Record<string, string> = {
        'x-request-token': token,
        'x-request-alias': this.alias,
      };

      let fetchBody = undefined;
      if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        headers['Content-Type'] = 'application/json';
        fetchBody = JSON.stringify(body);
      }

      const response = await fetch(url, {
        method,
        headers,
        body: fetchBody,
      });

      if (!response.ok) {
        if (response.status === 404) return null;
        console.error(`Metadata service returned ${response.status} for ${path}`);
        const text = await response.text();
        console.error(`Response: ${text}`);
        return null;
      }

      return (await response.json()) as T;
    } catch (err) {
      console.error(`Metadata request failed to ${path}:`, err);
      return null;
    }
  }

  async getUserConfig(loginName?: string) {
    const params: Record<string, string> = {};
    if (loginName) {
      params.login_name = loginName;
    } else {
      params.uid = this.owner;
    }
    return this.request<any[]>('GET', '/user', params);
  }

  async postAudit(endpoint: string, payload: any) {
    return this.request('POST', `/audit/${endpoint}`, undefined, payload);
  }

  async patchAudit(endpoint: string, payload: any) {
    return this.request('PATCH', `/audit/${endpoint}`, undefined, payload);
  }

  async getMcporterConfig() {
    return this.request('GET', '/mcporter/config', { uid: this.owner });
  }

  async getRestishConfig() {
    return this.request('GET', '/restish/config', { uid: this.owner });
  }
}

export const metadataClient = new MetadataClient();
