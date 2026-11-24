import { S3Client } from "@aws-sdk/client-s3";
import { Readable } from "stream";

import { getCacheEntry, s3Client } from "../src/custom/backend";
import { getReadS3Prefixes } from "../src/custom/prefix";

afterEach(() => {
    delete process.env.RUNS_ON_S3_BUCKET_CACHE;
    delete process.env.RUNS_ON_S3_CACHE_READ_PREFIXES;
    jest.restoreAllMocks();
});

test.each([
    ["UTF-8 BOM", "\uFEFF", "cache-key", "cache-key"],
    ["hexadecimal entity", "", "cache-&#x1F30D;", "cache-🌍"],
    ["decimal entity", "", "cache-&#127757;", "cache-🌍"],
    ["literal Unicode", "", "cache-🌍", "cache-🌍"],
    ["escaped entity text", "", "cache-&amp;#x1F30D;", "cache-&#x1F30D;"]
])("cache lookup preserves S3 XML with %s", async (_, bom, encodedKey, key) => {
    process.env.RUNS_ON_S3_BUCKET_CACHE = "cache-bucket";
    process.env.RUNS_ON_S3_CACHE_READ_PREFIXES = '["scope/default"]';
    const paths = ["node_modules"];
    const options = { enableCrossOsArchive: false };
    const prefix = getReadS3Prefixes(paths, options)[0];
    const client = new S3Client({
        region: "us-east-1",
        credentials: {
            accessKeyId: "test-key",
            secretAccessKey: "test-secret"
        },
        requestHandler: {
            handle: async () => ({
                response: {
                    statusCode: 200,
                    headers: { "content-type": "application/xml" },
                    body: Readable.from([
                        `${bom}<?xml version="1.0" encoding="UTF-8"?>` +
                            `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
                            `<IsTruncated>false</IsTruncated><Contents>` +
                            `<Key>${prefix}/${encodedKey}</Key>` +
                            `<LastModified>2026-01-01T00:00:00Z</LastModified>` +
                            `</Contents></ListBucketResult>`
                    ])
                }
            })
        }
    });
    // Keep the real SDK deserializer; replace only its HTTP transport.
    jest.spyOn(s3Client, "send").mockImplementation(command =>
        client.send(command)
    );
    try {
        await expect(getCacheEntry([key], paths, options)).resolves.toEqual({
            cacheKey: key,
            archiveLocation: `s3://cache-bucket/${prefix}/${key}`
        });
    } finally {
        client.destroy();
    }
});
