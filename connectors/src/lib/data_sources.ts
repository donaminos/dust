import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import logger from "@connectors/logger/logger";
import { statsDClient } from "@connectors/logger/withlogging";
import { DataSourceConfig } from "@connectors/types/data_source_config";

const { FRONT_API } = process.env;
if (!FRONT_API) {
  throw new Error("FRONT_API not set");
}

export async function upsertToDatasource(
  dataSourceConfig: DataSourceConfig,
  documentId: string,
  documentText: string,
  documentUrl?: string,
  timestampMs?: number,
  tags?: string[],
  retries = 10,
  delayBetweenRetriesMs = 500,
  loggerArgs: Record<string, string | number> = {}
) {
  if (retries < 1) {
    throw new Error("retries must be >= 1");
  }
  const errors = [];
  for (let i = 0; i < retries; i++) {
    try {
      return await _upsertToDatasource(
        dataSourceConfig,
        documentId,
        documentText,
        documentUrl,
        timestampMs,
        tags,
        loggerArgs
      );
    } catch (e) {
      const sleepTime = delayBetweenRetriesMs * (i + 1) ** 2;
      logger.warn(
        {
          error: e,
          attempt: i + 1,
          retries: retries,
          sleepTime: sleepTime,
        },
        "Error upserting to data source. Retrying..."
      );
      await new Promise((resolve) => setTimeout(resolve, sleepTime));
      errors.push(e);
    }
  }

  throw new Error(errors.join("\n"));
}

async function _upsertToDatasource(
  dataSourceConfig: DataSourceConfig,
  documentId: string,
  documentText: string,
  documentUrl?: string,
  timestamp?: number,
  tags?: string[],
  loggerArgs: Record<string, string | number> = {}
) {
  const localLogger = logger.child({ ...loggerArgs, documentId });

  const urlSafeName = encodeURIComponent(dataSourceConfig.dataSourceName);
  const endpoint = `${FRONT_API}/api/v1/w/${dataSourceConfig.workspaceId}/data_sources/${urlSafeName}/documents/${documentId}`;
  const dustRequestPayload = {
    text: documentText,
    source_url: documentUrl,
    timestamp,
    tags,
  };
  const dustRequestConfig: AxiosRequestConfig = {
    headers: {
      Authorization: `Bearer ${dataSourceConfig.workspaceAPIKey}`,
    },
  };

  let dustRequestResult: AxiosResponse;
  try {
    dustRequestResult = await axios.post(
      endpoint,
      dustRequestPayload,
      dustRequestConfig
    );
  } catch (e) {
    if (axios.isAxiosError(e) && e.config.data) {
      e.config.data = "[REDACTED]";
    }
    statsDClient.increment("data_source_upserts_error.count", 1, [
      `data_source_name:${dataSourceConfig.dataSourceName}`,
      `workspace_id:${dataSourceConfig.workspaceId}`,
    ]);
    localLogger.error({ error: e }, "Error uploading document to Dust.");
    throw e;
  }

  if (dustRequestResult.status >= 200 && dustRequestResult.status < 300) {
    statsDClient.increment("data_source_upserts_success.count", 1, [
      `data_source_name:${dataSourceConfig.dataSourceName}`,
      `workspace_id:${dataSourceConfig.workspaceId}`,
    ]);
    localLogger.info("Successfully uploaded document to Dust.");
  } else {
    statsDClient.increment("data_source_upserts_error.count", 1, [
      `data_source_name:${dataSourceConfig.dataSourceName}`,
      `workspace_id:${dataSourceConfig.workspaceId}`,
    ]);
    localLogger.error(
      {
        status: dustRequestResult.status,
      },
      "Error uploading document to Dust."
    );
    throw new Error(`Error uploading to dust: ${dustRequestResult}`);
  }
}

export async function deleteFromDataSource(
  dataSourceConfig: DataSourceConfig,
  documentId: string,
  loggerArgs: Record<string, string | number> = {}
) {
  const localLogger = logger.child({ ...loggerArgs, documentId });

  const urlSafeName = encodeURIComponent(dataSourceConfig.dataSourceName);
  const endpoint = `${FRONT_API}/api/v1/w/${dataSourceConfig.workspaceId}/data_sources/${urlSafeName}/documents/${documentId}`;
  const dustRequestConfig: AxiosRequestConfig = {
    headers: {
      Authorization: `Bearer ${dataSourceConfig.workspaceAPIKey}`,
    },
  };

  let dustRequestResult: AxiosResponse;
  try {
    dustRequestResult = await axios.delete(endpoint, dustRequestConfig);
  } catch (e) {
    localLogger.error({ error: e }, "Error deleting document from Dust.");
    throw e;
  }

  if (dustRequestResult.status >= 200 && dustRequestResult.status < 300) {
    localLogger.info("Successfully deleted document from Dust.");
  } else {
    localLogger.error(
      {
        status: dustRequestResult.status,
      },
      "Error deleting document from Dust."
    );
    throw new Error(`Error deleting from dust: ${dustRequestResult}`);
  }
}
