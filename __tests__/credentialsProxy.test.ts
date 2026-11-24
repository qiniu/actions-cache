import * as core from "@actions/core";
import { HttpClient } from "@actions/http-client";
import { readFileSync } from "fs";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import nock from "nock";
import { join } from "path";

import { runnerdCredentials } from "../src/custom/credentials";

// Test-only self-signed fixture. Trust only this certificate, without disabling
// TLS verification. The custom hostname has no direct public DNS route.
const cert = readFileSync(
    join(__dirname, "fixtures/credentials-proxy/cert.pem")
);
const key = readFileSync(join(__dirname, "fixtures/credentials-proxy/key.pem"));
const proxyVariables = [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy"
];
let savedEnv: NodeJS.ProcessEnv;
let origin: https.Server;
let proxy: http.Server;
let originURL: string;
let proxyURL: string;
let connections: string[];
let authorization: string[];
let sockets: Set<net.Socket>;
let status: number;
let stall: boolean;

async function listen(server: http.Server): Promise<number> {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as net.AddressInfo).port;
}

beforeEach(async () => {
    savedEnv = { ...process.env };
    for (const name of proxyVariables) delete process.env[name];
    jest.spyOn(core, "setSecret").mockImplementation();
    nock.enableNetConnect(/^(127\.0\.0\.1|runner\.proxy\.test)(:\d+)?$/);
    connections = [];
    authorization = [];
    sockets = new Set();
    status = 200;
    stall = false;
    origin = https.createServer({ cert, key }, (req, res) => {
        authorization.push(req.headers.authorization || "");
        res.writeHead(status, {
            location: "https://other.proxy.test/cache/credentials"
        });
        res.end(
            JSON.stringify({
                access_key_id: "sts-ak",
                secret_access_key: "sts-sk",
                session_token: "sts-token",
                expiration: new Date(Date.now() + 3600000).toISOString()
            })
        );
    });
    const port = await listen(origin);
    originURL = `https://runner.proxy.test:${port}/cache/credentials`;
    proxy = http.createServer();
    proxy.on("connect", (req, socket, head) => {
        connections.push(req.url || "");
        if (stall) return;
        const upstream = net.connect(port, "127.0.0.1", () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
        });
        sockets.add(upstream);
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
    });
    for (const server of [origin, proxy]) {
        server.on("connection", socket => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
        });
    }
    proxyURL = `http://127.0.0.1:${await listen(proxy)}`;
    const getAgent = HttpClient.prototype.getAgent;
    jest.spyOn(HttpClient.prototype, "getAgent").mockImplementation(function (
        this: HttpClient,
        url: string
    ) {
        const agent = getAgent.call(this, url);
        const options = (
            agent as http.Agent & { options: Record<string, unknown> }
        ).options;
        options.ca = cert;
        // Only the bypass case uses this resolver. Proxy CONNECT itself still
        // uses the real transport and the original runnerd hostname.
        options.lookup = (
            _host: string,
            options: { all?: boolean },
            callback: (...args: unknown[]) => void
        ) => {
            if (options.all)
                callback(null, [{ address: "127.0.0.1", family: 4 }]);
            else callback(null, "127.0.0.1", 4);
        };
        return agent;
    });
});

afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
        [origin, proxy].map(
            server =>
                new Promise<void>(resolve => server.close(() => resolve()))
        )
    );
    for (const name of proxyVariables) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
    }
    nock.disableNetConnect();
    jest.restoreAllMocks();
});

function credentials(): () => Promise<unknown> {
    const provider = runnerdCredentials({
        RUNS_ON_S3_CREDENTIALS_URL: originURL,
        RUNS_ON_S3_CREDENTIALS_TOKEN: "capability"
    });
    if (typeof provider !== "function")
        throw new Error("expected refresh provider");
    return provider;
}

test.each(["HTTPS_PROXY", "https_proxy"])(
    "refresh reaches runnerd via %s CONNECT proxy",
    async variable => {
        process.env[variable] = proxyURL;
        await expect(credentials()()).resolves.toMatchObject({
            accessKeyId: "sts-ak"
        });
        expect(connections).toEqual([new URL(originURL).host]);
        expect(authorization).toEqual(["Bearer capability"]);
    }
);

test.each(["NO_PROXY", "no_proxy"])(
    "%s bypasses the proxy for runnerd",
    async variable => {
        process.env.HTTPS_PROXY = proxyURL;
        process.env[variable] = "runner.proxy.test";
        await expect(credentials()()).resolves.toMatchObject({
            accessKeyId: "sts-ak"
        });
        expect(connections).toEqual([]);
        expect(authorization).toEqual(["Bearer capability"]);
    }
);

test("proxy refresh never follows redirects", async () => {
    process.env.HTTPS_PROXY = proxyURL;
    status = 302;
    await expect(credentials()()).rejects.toThrow(
        "Cache credential refresh rejected (HTTP 302)"
    );
    expect(connections).toHaveLength(1);
    expect(authorization).toEqual(["Bearer capability"]);
});

test("CONNECT stalls remain bounded by the refresh deadline", async () => {
    process.env.HTTPS_PROXY = proxyURL;
    stall = true;
    await expect(credentials()()).rejects.toThrow(
        "Cache credential refresh timed out"
    );
    expect(connections).toHaveLength(1);
    expect(authorization).toEqual([]);
}, 15000);
