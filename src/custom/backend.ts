import * as utils from "@actions/cache/lib/internal/cacheUtils";
import { DownloadOptions } from "@actions/cache/lib/options";
import * as core from "@actions/core";
import {
    GetObjectCommand,
    ListObjectsV2Command,
    S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream } from "fs";

import { downloadCacheHttpClientConcurrent } from "./downloadUtils";
import { getReadS3Prefixes, getWriteS3Prefix, S3PrefixOptions } from "./prefix";

const maxListPages = 10;

type S3Object = {
    Key?: string;
    LastModified?: Date;
};

export interface ArtifactCacheEntry {
    cacheKey?: string;
    scope?: string;
    cacheVersion?: string;
    creationTime?: string;
    archiveLocation?: string;
}

const runnerdCredentials = {
    accessKeyId: process.env.RUNS_ON_S3_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.RUNS_ON_S3_SECRET_ACCESS_KEY || "",
    sessionToken: process.env.RUNS_ON_S3_SESSION_TOKEN
};

const endpoint = process.env.RUNS_ON_S3_BUCKET_ENDPOINT;
function getBucketName(): string {
    const value = process.env.RUNS_ON_S3_BUCKET_CACHE;
    if (!value) {
        throw new Error("Environment variable RUNS_ON_S3_BUCKET_CACHE not set");
    }
    return value;
}
const region =
    process.env.RUNS_ON_AWS_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION;
const forcePathStyle =
    process.env.RUNS_ON_S3_FORCE_PATH_STYLE === "true" ||
    process.env.AWS_S3_FORCE_PATH_STYLE === "true";

const uploadQueueSize = Number(process.env.UPLOAD_QUEUE_SIZE || "4");
const uploadPartSize =
    Number(process.env.UPLOAD_PART_SIZE || "32") * 1024 * 1024;
const downloadQueueSize = Number(process.env.DOWNLOAD_QUEUE_SIZE || "8");
const downloadPartSize =
    Number(process.env.DOWNLOAD_PART_SIZE || "16") * 1024 * 1024;

export const s3Client = new S3Client({
    region,
    forcePathStyle,
    endpoint,
    credentials: runnerdCredentials
});

export async function getCacheEntry(
    keys: string[],
    paths: string[],
    options: S3PrefixOptions
): Promise<ArtifactCacheEntry> {
    const bucket = getBucketName();
    const readPrefixes = getReadS3Prefixes(paths, options);

    for (const s3Prefix of readPrefixes) {
        // Scope order is significant, but keys within one scope can be
        // searched concurrently because ListObjectsV2 is read-only. Keep the
        // original key order when selecting the first match.
        try {
            const matches = await Promise.all(
                keys.map(restoreKey => findCacheObject(s3Prefix, restoreKey))
            );
            for (const object of matches) {
                if (!object?.Key) {
                    continue;
                }
                return {
                    cacheKey: object.Key.slice(s3Prefix.length + 1),
                    archiveLocation: `s3://${bucket}/${object.Key}`
                };
            }
        } catch (error) {
            core.warning(
                `Skipping S3 cache scope ${s3Prefix}: ${(error as Error).message}`
            );
        }
    }

    return {};
}

export async function findCacheObject(
    s3Prefix: string,
    restoreKey: string
): Promise<S3Object | undefined> {
    const prefix = `${s3Prefix}/${restoreKey}`;
    const objects: S3Object[] = [];
    let continuationToken: string | undefined;

    for (let page = 0; page < maxListPages; page++) {
        const response = await s3Client.send(
            new ListObjectsV2Command({
                Bucket: getBucketName(),
                Prefix: prefix,
                ContinuationToken: continuationToken
            })
        );
        const contents = response.Contents || [];
        // S3 lists keys lexicographically; the exact key is always the first
        // entry of the first page when it exists, so return immediately.
        if (contents.some(object => object.Key === prefix)) {
            return contents.find(object => object.Key === prefix);
        }
        objects.push(...contents);
        if (!response.IsTruncated || !response.NextContinuationToken) {
            continuationToken = undefined;
            break;
        }
        continuationToken = response.NextContinuationToken;
    }
    if (continuationToken) {
        core.warning(
            `S3 cache search for ${prefix} reached the ${maxListPages}-page listing limit; selecting the best result scanned.`
        );
    }

    return selectCacheObject(objects, prefix);
}

export function selectCacheObject(
    objects: S3Object[],
    exactKey: string
): S3Object | undefined {
    const exact = objects.find(object => object.Key === exactKey);
    if (exact) {
        return exact;
    }
    return objects.reduce<S3Object | undefined>((newest, object) => {
        const objectTime = object.LastModified?.getTime() || 0;
        const newestTime = newest?.LastModified?.getTime() || 0;
        if (
            !newest ||
            objectTime > newestTime ||
            (objectTime === newestTime &&
                (object.Key || "") > (newest.Key || ""))
        ) {
            return object;
        }
        return newest;
    }, undefined);
}

export async function downloadCache(
    archiveLocation: string,
    archivePath: string,
    options?: DownloadOptions
): Promise<void> {
    const bucket = getBucketName();
    if (!region) {
        throw new Error("Environment variable RUNS_ON_AWS_REGION not set");
    }
    const archiveUrl = new URL(archiveLocation);
    const objectKey = archiveUrl.pathname.slice(1);

    // Retry logic for download validation failures
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const command = new GetObjectCommand({
                Bucket: bucket,
                Key: objectKey
            });
            const url = await getSignedUrl(s3Client, command, {
                expiresIn: 3600
            });

            await downloadCacheHttpClientConcurrent(url, archivePath, {
                ...options,
                downloadConcurrency: downloadQueueSize,
                concurrentBlobDownloads: true,
                partSize: downloadPartSize
            });

            // If we get here, download succeeded
            return;
        } catch (error) {
            const errorMessage = (error as Error).message;
            lastError = error as Error;

            // Only retry on validation failures, not on other errors
            if (
                errorMessage.includes("Download validation failed") ||
                errorMessage.includes("Range request not supported") ||
                errorMessage.includes("Content-Range header")
            ) {
                if (attempt < maxRetries) {
                    const delayMs = Math.pow(2, attempt - 1) * 1000; // exponential backoff
                    core.warning(
                        `Download attempt ${attempt} failed: ${errorMessage}. Retrying in ${delayMs}ms...`
                    );
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    continue;
                }
            }

            // For non-retryable errors or max retries reached, throw the error
            throw error;
        }
    }

    // This should never be reached, but just in case
    throw lastError || new Error("Download failed after all retry attempts");
}

export async function saveCache(
    key: string,
    paths: string[],
    archivePath: string,
    options
): Promise<boolean> {
    const { compressionMethod, enableCrossOsArchive } = options;
    const bucket = getBucketName();

    if (!region) {
        throw new Error("Environment variable RUNS_ON_AWS_REGION not set");
    }

    const s3Prefix = getWriteS3Prefix(paths, {
        compressionMethod,
        enableCrossOsArchive
    });
    if (!s3Prefix) {
        core.info(
            "Cache save skipped: RUNS_ON_S3_CACHE_WRITE_PREFIX is not set, so this workflow has no writable S3 cache scope."
        );
        return false;
    }
    const s3Key = `${s3Prefix}/${key}`;

    const multipartUpload = new Upload({
        client: s3Client,
        params: {
            Bucket: bucket,
            Key: s3Key,
            Body: createReadStream(archivePath)
        },
        // Part size in bytes
        partSize: uploadPartSize,
        // Max concurrency
        queueSize: uploadQueueSize
    });

    // Commit Cache
    const cacheSize = utils.getArchiveFileSizeInBytes(archivePath);
    core.info(
        `Cache Size: ~${Math.round(
            cacheSize / (1024 * 1024)
        )} MB (${cacheSize} B)`
    );

    const totalParts = Math.ceil(cacheSize / uploadPartSize);
    core.info(`Uploading cache from ${archivePath} to ${bucket}/${s3Key}`);
    multipartUpload.on("httpUploadProgress", progress => {
        core.info(`Uploaded part ${progress.part}/${totalParts}.`);
    });

    await multipartUpload.done();
    core.info(`Cache saved successfully.`);
    return true;
}
