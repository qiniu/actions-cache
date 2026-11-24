import * as core from "@actions/core";
import { HttpClient } from "@actions/http-client";
import { request } from "https";

interface CacheCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    expiration?: Date;
}

// Capture only runnerd's dedicated variables. Workflow AWS credentials must not
// replace the cache identity, including when the SDK refreshes it hours later.
export function runnerdCredentials(
    env: NodeJS.ProcessEnv = process.env
): CacheCredentials | (() => Promise<CacheCredentials>) {
    const endpoint = env.RUNS_ON_S3_CREDENTIALS_URL || "";
    const token = env.RUNS_ON_S3_CREDENTIALS_TOKEN || "";
    const initial = {
        accessKeyId: env.RUNS_ON_S3_ACCESS_KEY_ID || "",
        secretAccessKey: env.RUNS_ON_S3_SECRET_ACCESS_KEY || "",
        sessionToken: env.RUNS_ON_S3_SESSION_TOKEN
    };
    for (const secret of [token, ...Object.values(initial)]) {
        if (secret) core.setSecret(secret);
    }
    if (!endpoint && !token) return initial;

    // Validate inside the provider so a malformed configuration is handled by
    // the action's ordinary cache-error path. Never silently use stale keys.
    return async () => {
        let url: URL;
        try {
            url = new URL(endpoint);
        } catch {
            throw new Error("Invalid runnerd cache credentials endpoint");
        }
        if (
            !token ||
            token.length > 16384 ||
            /[\r\n]/.test(token) ||
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== "/cache/credentials"
        ) {
            throw new Error("Invalid runnerd cache refresh configuration");
        }
        return fetchCredentials(url, token);
    };
}

function fetchCredentials(url: URL, token: string): Promise<CacheCredentials> {
    return new Promise((resolve, reject) => {
        // Use the same proxy and NO_PROXY rules as cache downloads. Keep the
        // raw HTTPS request so redirects, byte limits and the total deadline
        // remain under our control.
        const client = new HttpClient("qiniu-actions-cache", undefined, {
            keepAlive: false
        });
        let agent: ReturnType<typeof client.getAgent>;
        try {
            agent = client.getAgent(url.href);
        } catch {
            client.dispose();
            reject(new Error("Invalid cache credential proxy configuration"));
            return;
        }
        const req = request(
            url,
            {
                method: "POST",
                agent,
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/json"
                }
            },
            res => {
                // Native HTTPS never follows redirects. Neither response bodies
                // nor transport messages may be echoed into workflow logs.
                if (res.statusCode !== 200) {
                    res.destroy();
                    finish(
                        new Error(
                            `Cache credential refresh rejected (HTTP ${res.statusCode || 0})`
                        )
                    );
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > 16384) {
                        res.destroy();
                        finish(
                            new Error("Cache credential response exceeds limit")
                        );
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("error", () =>
                    finish(new Error("Cache credential response failed"))
                );
                res.on("end", () => {
                    try {
                        const body = JSON.parse(
                            Buffer.concat(chunks).toString("utf8")
                        );
                        const expiration = new Date(body.expiration);
                        if (
                            ![
                                body.access_key_id,
                                body.secret_access_key,
                                body.session_token
                            ].every(
                                value =>
                                    typeof value === "string" &&
                                    value.trim().length > 0
                            ) ||
                            !Number.isFinite(expiration.getTime()) ||
                            expiration.getTime() <= Date.now() + 60000
                        )
                            throw new Error("invalid credentials");
                        for (const secret of [
                            body.access_key_id,
                            body.secret_access_key,
                            body.session_token
                        ]) {
                            core.setSecret(secret);
                        }
                        finish();
                        resolve({
                            accessKeyId: body.access_key_id,
                            secretAccessKey: body.secret_access_key,
                            sessionToken: body.session_token,
                            expiration
                        });
                    } catch {
                        finish(
                            new Error(
                                "Invalid or expired cache credential response"
                            )
                        );
                    }
                });
            }
        );
        const timer = setTimeout(() => {
            req.destroy();
            finish(new Error("Cache credential refresh timed out"));
        }, 10000);
        function finish(error?: Error): void {
            clearTimeout(timer);
            client.dispose();
            if (error) reject(error);
        }
        req.on("error", () =>
            finish(new Error("Cache credential refresh failed"))
        );
        req.end();
    });
}
