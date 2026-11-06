import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * Centralized Gateway providing controlled, authenticated, and audited external
 * connectivity for sandboxed AI agents.
 */
export class PrisonGateway {
  /**
   * @param {Object} [options]
   * @param {string[]} [options.allowedHosts] - Permitted target hostnames (wildcards supported like '*.github.com')
   * @param {string[]} [options.deniedHosts] - Explicitly blocked hostnames
   * @param {string} [options.secretToken] - Required authentication token for forwarding requests
   */
  constructor(options = {}) {
    this.allowedHosts = new Set(options.allowedHosts ?? ['*']);
    this.deniedHosts = new Set(options.deniedHosts ?? ['localhost', '127.0.0.1', '0.0.0.0']);
    this.secretToken = options.secretToken ?? null;
    this.auditLog = [];
    this.maxAuditEntries = 1000;
  }

  /**
   * Sets or updates permitted hosts for outbound requests.
   *
   * @param {string[]} hosts
   */
  setAllowedHosts(hosts) {
    this.allowedHosts = new Set(hosts);
  }

  /**
   * Verifies if a given destination host is permitted under the gateway policy.
   *
   * @param {string} hostname
   * @returns {boolean}
   */
  isHostPermitted(hostname) {
    if (!hostname) return false;
    const lower = hostname.toLowerCase();

    // Check denied list first
    for (const denied of this.deniedHosts) {
      if (lower === denied || lower.endsWith('.' + denied)) {
        return false;
      }
    }

    // Check allowed list
    if (this.allowedHosts.has('*')) return true;
    for (const allowed of this.allowedHosts) {
      if (allowed === lower) return true;
      if (allowed.startsWith('*.') && (lower.endsWith(allowed.slice(1)) || lower === allowed.slice(2))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Forwards an authorized outbound HTTP/HTTPS request for a sandbox.
   *
   * @param {Object} reqOptions
   * @param {string} reqOptions.sandboxId - Calling sandbox identifier
   * @param {string} reqOptions.url - Target URL
   * @param {string} [reqOptions.method='GET'] - HTTP method
   * @param {Object} [reqOptions.headers={}] - Outbound headers
   * @param {string|Buffer} [reqOptions.body] - Request payload
   * @param {string} [reqOptions.authToken] - Token verifying the sandbox's authority
   * @returns {Promise<{ statusCode: number, headers: Object, body: string, durationMs: number }>}
   */
  async forward({ sandboxId, url, method = 'GET', headers = {}, body = null, authToken = null }) {
    const startTime = Date.now();
    const parsedUrl = new URL(url);

    // 1. Authentication check
    if (this.secretToken && authToken !== this.secretToken) {
      const errRes = {
        statusCode: 401,
        headers: {},
        body: JSON.stringify({ error: 'Unauthorized: Invalid or missing gateway token' }),
        durationMs: Date.now() - startTime,
      };
      this._logAudit({ sandboxId, url, method, statusCode: 401, durationMs: errRes.durationMs });
      return errRes;
    }

    // 2. Policy enforcement (allowed / denied hosts)
    if (!this.isHostPermitted(parsedUrl.hostname)) {
      const forbiddenRes = {
        statusCode: 403,
        headers: {},
        body: JSON.stringify({ error: `Forbidden: Host "${parsedUrl.hostname}" not permitted by gateway policy` }),
        durationMs: Date.now() - startTime,
      };
      this._logAudit({ sandboxId, url, method, statusCode: 403, durationMs: forbiddenRes.durationMs });
      return forbiddenRes;
    }

    // 3. Request dispatch
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const requestHeaders = { ...headers, 'x-forwarded-by': 'prison-gateway' };
    delete requestHeaders.host; // let client set correct Host

    return new Promise((resolve, reject) => {
      const req = protocol.request(
        parsedUrl,
        {
          method,
          headers: requestHeaders,
          timeout: 15_000,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk) => {
            responseBody += chunk.toString();
          });
          res.on('end', () => {
            const durationMs = Date.now() - startTime;
            const result = {
              statusCode: res.statusCode ?? 200,
              headers: res.headers,
              body: responseBody,
              durationMs,
            };
            this._logAudit({
              sandboxId,
              url,
              method,
              statusCode: result.statusCode,
              durationMs,
            });
            resolve(result);
          });
        },
      );

      req.on('error', (err) => {
        const durationMs = Date.now() - startTime;
        this._logAudit({
          sandboxId,
          url,
          method,
          statusCode: 502,
          error: err.message,
          durationMs,
        });
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Gateway request to ${url} timed out`));
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  /**
   * Internal audit trail recorder.
   */
  _logAudit(entry) {
    this.auditLog.push({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog.shift();
    }
  }

  /**
   * Returns recent audit logs.
   *
   * @param {Object} [filter]
   * @param {string} [filter.sandboxId]
   * @param {number} [filter.limit=50]
   */
  getAuditLogs({ sandboxId = null, limit = 50 } = {}) {
    let logs = this.auditLog;
    if (sandboxId) {
      logs = logs.filter((log) => log.sandboxId === sandboxId);
    }
    return logs.slice(-limit);
  }
}
