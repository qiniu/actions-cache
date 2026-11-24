import * as core from "@actions/core";
import {
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client
} from "@aws-sdk/client-s3";
import nock from "nock";

import { runnerdCredentials } from "../src/custom/credentials";

const endpoint = "https://runner.example.test";
const env = {
    RUNS_ON_S3_CREDENTIALS_URL: endpoint + "/cache/credentials",
    RUNS_ON_S3_CREDENTIALS_TOKEN: "attempt-capability",
    RUNS_ON_S3_ACCESS_KEY_ID: "initial-ak",
    RUNS_ON_S3_SECRET_ACCESS_KEY: "initial-sk",
    RUNS_ON_S3_SESSION_TOKEN: "initial-token"
};

beforeEach(() => jest.spyOn(core, "setSecret").mockImplementation());
afterEach(() => {
    nock.cleanAll();
    jest.restoreAllMocks();
});

function response(now = Date.now(), id = "1"): object {
    return {
        access_key_id: "sts-ak-" + id,
        secret_access_key: "sts-sk-" + id,
        session_token: "sts-token-" + id,
        expiration: new Date(now + 3600000).toISOString()
    };
}

test("SDK renews the exact cache identity throughout a 24-hour job", async () => {
    let now = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => now);
    const mutableEnv = { ...env, AWS_ACCESS_KEY_ID: "workflow-aws-key" };
    const sessions: string[] = [];
    const client = new S3Client({
        region: "cn-east-1",
        endpoint: "https://s3.example.test",
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: runnerdCredentials(mutableEnv),
        requestHandler: {
            handle: async request => {
                sessions.push(request.headers["x-amz-security-token"]);
                return {
                    response: {
                        statusCode: 200,
                        headers: { "content-type": "application/xml" },
                        body: Buffer.from("<ListBucketResult/>")
                    }
                };
            }
        }
    });
    // Mutating either AWS variables or the original object cannot redirect an
    // already-created cache provider or replace its capability.
    mutableEnv.RUNS_ON_S3_CREDENTIALS_TOKEN = "other-capability";
    mutableEnv.RUNS_ON_S3_CREDENTIALS_URL =
        "https://attacker.test/cache/credentials";
    for (let hour = 0; hour <= 24; hour++) {
        const refresh = nock(endpoint)
            .post("/cache/credentials")
            .matchHeader("authorization", "Bearer attempt-capability")
            .reply(200, response(now, String(hour)));
        await client.send(new ListObjectsV2Command({ Bucket: "cache" }));
        await client.send(new ListObjectsV2Command({ Bucket: "cache" }));
        expect(refresh.isDone()).toBe(true);
        expect(sessions.slice(-2)).toEqual([
            "sts-token-" + hour,
            "sts-token-" + hour
        ]);
        now += 3600000;
    }
    client.destroy();
});

test("legacy runners keep a snapshot of dedicated credentials", () => {
    expect(
        runnerdCredentials({
            RUNS_ON_S3_ACCESS_KEY_ID: "dedicated-ak",
            RUNS_ON_S3_SECRET_ACCESS_KEY: "dedicated-sk",
            AWS_ACCESS_KEY_ID: "workflow-ak"
        })
    ).toEqual({
        accessKeyId: "dedicated-ak",
        secretAccessKey: "dedicated-sk",
        sessionToken: undefined
    });
});

test.each([
    "http://runner.example.test/cache/credentials",
    "https://user:password@runner.example.test/cache/credentials",
    "https://runner.example.test/cache/credentials?token=secret",
    "https://runner.example.test/other"
])("rejects unsafe refresh endpoint %s", async url => {
    const provider = runnerdCredentials({
        ...env,
        RUNS_ON_S3_CREDENTIALS_URL: url
    });
    expect(typeof provider).toBe("function");
    if (typeof provider === "function")
        await expect(provider()).rejects.toThrow(
            "Invalid runnerd cache refresh configuration"
        );
});

test.each([302, 400, 403, 429, 503])(
    "does not leak provider error bodies or follow HTTP %i",
    async status => {
        const upstream = nock(endpoint)
            .post("/cache/credentials")
            .reply(status, "private-secret-echo", {
                location: "https://attacker.test/"
            });
        const provider = runnerdCredentials(env);
        if (typeof provider !== "function")
            throw new Error("expected refresh provider");
        await expect(provider()).rejects.toThrow(
            `Cache credential refresh rejected (HTTP ${status})`
        );
        expect(upstream.isDone()).toBe(true);
    }
);

test.each([
    {},
    { ...response(), secret_access_key: "" },
    { ...response(), expiration: "invalid-private-secret" },
    { ...response(), expiration: new Date(0).toISOString() }
])(
    "rejects malformed or expired credentials without static fallback",
    async body => {
        nock(endpoint).post("/cache/credentials").reply(200, body);
        const provider = runnerdCredentials(env);
        if (typeof provider !== "function")
            throw new Error("expected refresh provider");
        await expect(provider()).rejects.toThrow(
            "Invalid or expired cache credential response"
        );
    }
);

test("bounds credential response bytes", async () => {
    nock(endpoint).post("/cache/credentials").reply(200, "x".repeat(16385));
    const provider = runnerdCredentials(env);
    if (typeof provider !== "function")
        throw new Error("expected refresh provider");
    await expect(provider()).rejects.toThrow(
        "Cache credential response exceeds limit"
    );
});

test("a fresh post-job process saves with renewed credentials after 24 hours", async () => {
    const now = Date.now() + 24 * 3600000;
    jest.spyOn(Date, "now").mockReturnValue(now);
    const refresh = nock(endpoint)
        .post("/cache/credentials")
        .matchHeader("authorization", "Bearer attempt-capability")
        .reply(200, response(now, "post-job"));
    const client = new S3Client({
        region: "cn-east-1",
        endpoint: "https://s3.example.test",
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: runnerdCredentials({ ...env }),
        requestHandler: {
            handle: async request => {
                expect(request.method).toBe("PUT");
                expect(request.headers["x-amz-security-token"]).toBe(
                    "sts-token-post-job"
                );
                expect(request.headers.authorization).toContain(
                    "sts-ak-post-job/"
                );
                return {
                    response: {
                        statusCode: 200,
                        headers: {},
                        body: Buffer.from("")
                    }
                };
            }
        }
    });
    await client.send(
        new PutObjectCommand({
            Bucket: "cache",
            Key: "scope/key",
            Body: "cache-data"
        })
    );
    expect(refresh.isDone()).toBe(true);
    client.destroy();
});
