import type { AgentMessageType, ModelId } from "@dust-tt/types";
import { assertNever, isEmptyString, minTranscriptsSize } from "@dust-tt/types";
import { Err } from "@dust-tt/types";
import marked from "marked";
import sanitizeHtml from "sanitize-html";

import { getAgentConfiguration } from "@app/lib/api/assistant/configuration";
import {
  createConversation,
  getConversation,
  postNewContentFragment,
} from "@app/lib/api/assistant/conversation";
import { postUserMessageWithPubSub } from "@app/lib/api/assistant/pubsub";
import { Authenticator } from "@app/lib/auth";
import { sendEmail } from "@app/lib/email";
import { Workspace } from "@app/lib/models/workspace";
import { LabsTranscriptsConfigurationResource } from "@app/lib/resources/labs_transcripts_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import mainLogger from "@app/logger/logger";
import {
  retrieveGongTranscriptContent,
  retrieveGongTranscripts,
} from "@app/temporal/labs/utils/gong";
import {
  retrieveGoogleTranscriptContent,
  retrieveGoogleTranscripts,
} from "@app/temporal/labs/utils/google";

export async function retrieveNewTranscriptsActivity(
  transcriptsConfigurationId: ModelId
): Promise<string[]> {
  const localLogger = mainLogger.child({
    transcriptsConfigurationId,
  });

  const transcriptsConfiguration =
    await LabsTranscriptsConfigurationResource.fetchByModelId(
      transcriptsConfigurationId
    );

  if (!transcriptsConfiguration) {
    localLogger.error(
      {},
      "[retrieveNewTranscripts] Transcript configuration not found. Skipping."
    );
    return [];
  }

  const workspace = await Workspace.findOne({
    where: {
      id: transcriptsConfiguration.workspaceId,
    },
  });

  if (!workspace) {
    throw new Error(
      `Could not find workspace for user (workspaceId: ${transcriptsConfiguration.workspaceId}).`
    );
  }

  const auth = await Authenticator.internalBuilderForWorkspace(workspace.sId);

  if (!auth.workspace()) {
    localLogger.error(
      {},
      "[retrieveNewTranscripts] Workspace not found. Stopping."
    );
    return [];
  }

  const transcriptsIdsToProcess: string[] = [];

  switch (transcriptsConfiguration.provider) {
    case "google_drive":
      const googleTranscriptsIds = await retrieveGoogleTranscripts(
        auth,
        transcriptsConfiguration,
        localLogger
      );
      transcriptsIdsToProcess.push(...googleTranscriptsIds);
      break;

    case "gong":
      const gongTranscriptsIds = await retrieveGongTranscripts(
        auth,
        transcriptsConfiguration,
        localLogger
      );
      transcriptsIdsToProcess.push(...gongTranscriptsIds);
      break;

    default:
      assertNever(transcriptsConfiguration.provider);
  }

  return transcriptsIdsToProcess;
}

export async function processTranscriptActivity(
  transcriptsConfigurationId: ModelId,
  fileId: string
) {
  const transcriptsConfiguration =
    await LabsTranscriptsConfigurationResource.fetchByModelId(
      transcriptsConfigurationId
    );

  if (!transcriptsConfiguration) {
    throw new Error(
      `Could not find transcript configuration for id ${transcriptsConfigurationId}.`
    );
  }

  const workspace = await Workspace.findOne({
    where: {
      id: transcriptsConfiguration.workspaceId,
    },
  });

  if (!workspace) {
    throw new Error(
      `Could not find workspace for user (workspaceId: ${transcriptsConfiguration.workspaceId}).`
    );
  }

  const user = await UserResource.fetchByModelId(
    transcriptsConfiguration.userId
  );

  if (!user) {
    throw new Error(
      `Could not find user for id ${transcriptsConfiguration.userId}.`
    );
  }

  const auth = await Authenticator.fromUserIdAndWorkspaceId(
    user.sId,
    workspace.sId
  );

  if (!auth.workspace()) {
    throw new Error(
      `Could not find workspace for user (workspaceId: ${transcriptsConfiguration.workspaceId}).`
    );
  }

  if (!auth.user() || !auth.isUser()) {
    throw new Error(
      `Could not find user for id ${transcriptsConfiguration.userId}.`
    );
  }

  const localLogger = mainLogger.child({
    userId: user.id,
    fileId,
    transcriptsConfigurationId,
  });

  localLogger.info(
    {},
    "[processTranscriptActivity] Starting processing of file."
  );

  const hasExistingHistory =
    await transcriptsConfiguration.fetchHistoryForFileId(fileId);
  if (hasExistingHistory) {
    localLogger.info(
      {},
      "[processTranscriptActivity] History record already exists. Stopping."
    );
    return;
  }

  let transcriptTitle = "";
  let transcriptContent = "";

  switch (transcriptsConfiguration.provider) {
    case "google_drive":
      const googleResult = await retrieveGoogleTranscriptContent(
        auth,
        transcriptsConfiguration,
        fileId,
        localLogger
      );
      transcriptTitle = googleResult.transcriptTitle;
      transcriptContent = googleResult.transcriptContent;
      break;

    case "gong":
      const gongResult = await retrieveGongTranscriptContent(
        auth,
        transcriptsConfiguration,
        fileId,
        localLogger
      );
      transcriptTitle = gongResult?.transcriptTitle || "";
      transcriptContent = gongResult?.transcriptContent || "";
      break;

    default:
      assertNever(transcriptsConfiguration.provider);
  }

  // Short transcripts are likely not useful to process.
  if (transcriptContent.length < minTranscriptsSize) {
    localLogger.info(
      {},
      "[processTranscriptActivity] Transcript content too short or empty. Skipping."
    );
    await transcriptsConfiguration.recordHistory({
      configurationId: transcriptsConfiguration.id,
      fileId,
      fileName: transcriptTitle,
      conversationId: null,
    });
    const msg = {
      from: {
        name: "Dust team",
        email: "team@dust.help",
      },
      subject: `[DUST] - Unable to Generate Your Meeting Transcript Summary`,
      html: `<p>Dear ${user.fullName()},</p>
        <p>We encountered an issue while trying to generate a summary for your recent Google Meet session. Unfortunately, the transcript provided by Google was either too short or empty, which prevented us from creating a meaningful summary.</p>
        <p>What you can do:</p>
        <ul>
        <li>Check your Google Meet settings to ensure transcription is properly enabled;</li>
        <li>If this issue persists, you may want to contact Google Meet support for assistance with their transcription service.</li>
        </ul>
        <p>We apologize for any inconvenience this may have caused. If you have any questions or need further assistance, please don't hesitate to reach out to our support team at <a href="mailto:support@dust.tt">support@dust.tt</a>.</p>
        <p>Thank you for your understanding,</p>
        <p>Best regards,</p>
        <p>The Team at Dust</p>`,
    };
    await sendEmail(user.email, msg);
    return;
  }

  const owner = auth.workspace();

  if (!owner) {
    localLogger.error(
      {},
      "[processTranscriptActivity] No owner found. Stopping."
    );
    return;
  }

  const { agentConfigurationId } = transcriptsConfiguration;

  if (!agentConfigurationId) {
    localLogger.error(
      {},
      "[processTranscriptActivity] No agent configuration id found. Stopping."
    );
    return;
  }

  const agent = await getAgentConfiguration(auth, agentConfigurationId);

  if (!agent) {
    localLogger.error(
      {},
      "[processTranscriptActivity] Agent configuration not found. Stopping."
    );
    return;
  }

  if (isEmptyString(user.username)) {
    return new Err(new Error("username must be a non-empty string"));
  }

  let conversation = await createConversation(auth, {
    title: transcriptTitle,
    visibility: "workspace",
  });

  const baseContext = {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    username: user.username,
    fullName: user.fullName(),
    email: user.email,
    profilePictureUrl: user.imageUrl,
    origin: null,
  };

  const contentFragmentData = {
    title: transcriptTitle,
    content: transcriptContent.toString(),
    url: null,
    contentType: "text/plain",
    baseContext,
  };

  const contentFragmentRes = await postNewContentFragment(
    auth,
    conversation,
    contentFragmentData,
    baseContext
  );

  if (contentFragmentRes.isErr()) {
    localLogger.error(
      {
        agentConfigurationId,
        conversationSid: conversation.sId,
        error: contentFragmentRes.error,
      },
      "[processTranscriptActivity] Error creating content fragment. Stopping."
    );
    return;
  }

  const messageRes = await postUserMessageWithPubSub(
    auth,
    {
      conversation,
      content: `Transcript: ${transcriptTitle}`,
      mentions: [{ configurationId: agentConfigurationId }],
      context: baseContext,
    },
    { resolveAfterFullGeneration: true }
  );

  if (messageRes.isErr()) {
    localLogger.error(
      {
        agentConfigurationId,
        conversationSid: conversation.sId,
        error: messageRes.error,
      },
      "[processTranscriptActivity] Error creating message. Stopping."
    );
    return;
  }

  const updated = await getConversation(auth, conversation.sId);

  if (!updated) {
    localLogger.error(
      {
        agentConfigurationId,
        conversationSid: conversation.sId,
      },
      "[processTranscriptActivity] Error getting conversation after creation. Stopping."
    );
    return;
  }

  conversation = updated;

  localLogger.info(
    {
      agentConfigurationId,
      conservationSid: conversation.sId,
    },
    "[processTranscriptActivity] Created conversation."
  );

  // Get first from array with type='agent_message' in conversation.content;
  const agentMessage = <AgentMessageType[]>conversation.content.find(
    (innerArray) => {
      return innerArray.find((item) => item.type === "agent_message");
    }
  );
  const markDownAnswer =
    agentMessage && agentMessage[0].content ? agentMessage[0].content : "";
  const htmlAnswer = sanitizeHtml(await marked.parse(markDownAnswer), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]), // Allow images on top of all defaults from https://www.npmjs.com/package/sanitize-html
  });

  await transcriptsConfiguration.recordHistory({
    configurationId: transcriptsConfiguration.id,
    fileId,
    fileName: transcriptTitle,
    conversationId: conversation.sId,
  });

  const msg = {
    from: {
      name: "Dust team",
      email: "team@dust.help",
    },
    subject: `[DUST] Meeting summary - ${transcriptTitle}`,
    html: `<a href="https://dust.tt/w/${owner.sId}/assistant/${conversation.sId}">Open this conversation in Dust</a><br /><br /> ${htmlAnswer}<br /><br />The team at <a href="https://dust.tt">Dust.tt</a>`,
  };

  await sendEmail(user.email, msg);
}
