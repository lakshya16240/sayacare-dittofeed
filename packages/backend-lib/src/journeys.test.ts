import { randomUUID } from "crypto";
import { PgInsertValue } from "drizzle-orm/pg-core";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import * as R from "remeda";

import { submitTrack } from "./apps/track";
import { db, insert } from "./db";
import {
  journey as dbJourney,
  userJourneyEvent as dbUserJourneyEvent,
} from "./db/schema";
import {
  getJourneyMessageStats,
  getJourneysStats,
  getUserJourneys,
  upsertJourney,
} from "./journeys";
import { recordNodeProcessed } from "./journeys/recordNodeProcessed";
import {
  ChannelType,
  EmailProviderType,
  InternalEventType,
  JourneyDefinition,
  JourneyNodeType,
  JourneyResourceStatusEnum,
  JourneyUpsertValidationErrorType,
  MessageNode,
  MessageServiceFailureVariant,
  NodeStatsType,
  SegmentEntryNode,
  SegmentSplitNode,
  SegmentSplitVariantType,
  Workspace,
} from "./types";
import { createWorkspace } from "./workspaces";

describe("journeys", () => {
  let workspaceId: string;
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = unwrap(
      await createWorkspace({
        id: randomUUID(),
        name: randomUUID(),
        updatedAt: new Date(),
      }),
    );
    workspaceId = workspace.id;
  });

  describe("getJourneyMessageStats", () => {
    let journeyId: string;
    let messageNodeId: string;

    beforeEach(async () => {
      messageNodeId = randomUUID();

      const journeyDefinition: JourneyDefinition = {
        entryNode: {
          type: JourneyNodeType.SegmentEntryNode,
          segment: randomUUID(),
          child: messageNodeId,
        },
        exitNode: {
          type: JourneyNodeType.ExitNode,
        },
        nodes: [
          {
            id: messageNodeId,
            type: JourneyNodeType.MessageNode,
            variant: {
              type: ChannelType.Email,
              templateId: randomUUID(),
            },
            child: JourneyNodeType.ExitNode,
          },
        ],
      };
      journeyId = randomUUID();
      await db().insert(dbJourney).values({
        workspaceId,
        id: journeyId,
        definition: journeyDefinition,
        name: randomUUID(),
        status: "Running",
      });
    });

    describe("when the the message has one failed message one delivered message one bounced message and one marked as spam", () => {
      beforeEach(async () => {
        const messageId1 = randomUUID();
        const messageId2 = randomUUID();
        const messageId3 = randomUUID();
        const messageId4 = randomUUID();
        const userId1 = randomUUID();
        const userId2 = randomUUID();
        const userId3 = randomUUID();
        const userId4 = randomUUID();
        const now = Date.now();

        await Promise.all([
          // message 1 failed
          submitTrack({
            workspaceId,
            data: {
              userId: userId1,
              messageId: messageId1,
              event: InternalEventType.MessageFailure,
              timestamp: new Date(now).toISOString(),
              properties: {
                journeyId,
                runId: `run-${userId1}`,
                templateId: `template-${messageNodeId}`,
                nodeId: messageNodeId,
                variant: {
                  type: ChannelType.Email,
                  provider: {
                    type: EmailProviderType.Resend,
                    name: "error name",
                    message: "error message",
                  },
                } satisfies MessageServiceFailureVariant,
              },
            },
          }),
          // message 2 delivered
          submitTrack({
            workspaceId,
            data: {
              userId: userId2,
              messageId: messageId2,
              event: InternalEventType.MessageSent,
              timestamp: new Date(now).toISOString(),
              properties: {
                from: "from@email.com",
                to: "to@email.com",
                body: "hello",
                subject: "hello",
                nodeId: messageNodeId,
                templateId: `template-${messageNodeId}`,
                journeyId,
                channel: ChannelType.Email,
                runId: `run-${userId2}`,
              },
            },
          }),
          submitTrack({
            workspaceId,
            data: {
              userId: userId2,
              messageId: randomUUID(),
              event: InternalEventType.EmailDelivered,
              timestamp: new Date(now + 100).toISOString(),
              properties: {
                messageId: messageId2,
                nodeId: messageNodeId,
                templateId: `template-${messageNodeId}`,
                journeyId,
                channel: ChannelType.Email,
                runId: `run-${userId2}`,
              },
            },
          }),
          // message 3 bounced
          submitTrack({
            workspaceId,
            data: {
              userId: userId3,
              messageId: messageId3,
              event: InternalEventType.MessageSent,
              timestamp: new Date(now).toISOString(),
              properties: {
                from: "from@email.com",
                to: "to@email.com",
                body: "hello",
                subject: "hello",
                nodeId: messageNodeId,
                templateId: `template-${messageNodeId}`,
                journeyId,
                channel: ChannelType.Email,
                runId: `run-${userId3}`,
              },
            },
          }),
          submitTrack({
            workspaceId,
            data: {
              userId: userId3,
              messageId: randomUUID(),
              event: InternalEventType.EmailBounced,
              timestamp: new Date(now + 100).toISOString(),
              properties: {
                messageId: messageId3,
                nodeId: messageNodeId,
                templateId: `template-${messageNodeId}`,
                journeyId,
                channel: ChannelType.Email,
                runId: `run-${userId3}`,
              },
            },
          }),
          // message 4 marked as spam
          submitTrack({
            workspaceId,
            data: {
              userId: userId4,
              messageId: messageId4,
              event: InternalEventType.MessageSent,
              timestamp: new Date(now).toISOString(),
              properties: {
                from: "from@email.com",
                to: "to@email.com",
                body: "hello",
                subject: "hello",
                nodeId: messageNodeId,
                templateId: `template-${messageNodeId}`,
                journeyId,
                channel: ChannelType.Email,
                runId: `run-${userId4}`,
              },
            },
          }),
          submitTrack({
            workspaceId,
            data: {
              userId: userId4,
              messageId: randomUUID(),
              event: InternalEventType.EmailDelivered,
              timestamp: new Date(now + 100).toISOString(),
              properties: {
                messageId: messageId4,
                nodeId: messageNodeId,
                templateId: `template-${messageNodeId}`,
                journeyId,
                channel: ChannelType.Email,
                runId: `run-${userId4}`,
              },
            },
          }),
          submitTrack({
            workspaceId,
            data: {
              userId: userId4,
              messageId: randomUUID(),
              event: InternalEventType.EmailMarkedSpam,
              timestamp: new Date(now + 5000).toISOString(),
              properties: {
                messageId: messageId4,
                nodeId: messageNodeId,
                templateId: `template-${messageNodeId}`,
                journeyId,
                channel: ChannelType.Email,
                runId: `run-${userId4}`,
              },
            },
          }),
        ]);
      });
      it("returns the correct stats", async () => {
        const stats = await getJourneyMessageStats({
          workspaceId,
          journeys: [
            {
              id: journeyId,
              nodes: [
                {
                  id: messageNodeId,
                  channel: ChannelType.Email,
                },
              ],
            },
          ],
        });
        expect(stats).toEqual([
          {
            journeyId,
            nodeId: messageNodeId,
            stats: {
              channelStats: {
                clickRate: 0,
                deliveryRate: 0.5,
                openRate: 0.25,
                spamRate: 0.25,
                type: ChannelType.Email,
              },
              sendRate: 0.75,
            },
          },
        ]);
      });
    });
  });
  describe("getJourneysStats", () => {
    let journeyId: string;

    describe("when a journey node has associated message stats", () => {
      let messageNodeId: string;

      beforeEach(async () => {
        messageNodeId = randomUUID();
        const entryNode = {
          type: JourneyNodeType.SegmentEntryNode,
          segment: randomUUID(),
          child: messageNodeId,
        } as const;
        const messageNode = {
          id: messageNodeId,
          type: JourneyNodeType.MessageNode,
          variant: {
            type: ChannelType.Email,
            templateId: randomUUID(),
          },
          child: JourneyNodeType.ExitNode,
        } as const;

        const journeyDefinition: JourneyDefinition = {
          entryNode,
          exitNode: {
            type: JourneyNodeType.ExitNode,
          },
          nodes: [messageNode],
        };
        journeyId = randomUUID();
        await db().insert(dbJourney).values({
          workspaceId,
          id: journeyId,
          definition: journeyDefinition,
          name: randomUUID(),
          status: JourneyResourceStatusEnum.Running,
          canRunMultiple: false,
          resourceType: "Declarative",
          draft: null,
          statusUpdatedAt: new Date(),
        });

        const userId = randomUUID();

        await Promise.all([
          submitTrack({
            workspaceId,
            data: {
              userId,
              messageId: randomUUID(),
              event: InternalEventType.MessageSent,
              properties: {
                from: "from@email.com",
                to: "to@email.com",
                body: "hello",
                subject: "hello",
                nodeId: messageNodeId,
                templateId: randomUUID(),
                journeyId,
                channel: ChannelType.Email,
                runId: randomUUID(),
              },
            },
          }),
          recordNodeProcessed({
            journeyStartedAt: Date.now(),
            journeyId,
            node: entryNode,
            workspaceId,
            userId,
          }),
          recordNodeProcessed({
            journeyStartedAt: Date.now(),
            journeyId,
            node: messageNode,
            workspaceId,
            userId,
          }),
        ]);
      });
      it("returns the stats", async () => {
        const stats = await getJourneysStats({
          workspaceId,
          journeyIds: [journeyId],
        });
        expect(stats).toEqual([
          {
            workspaceId,
            journeyId,
            nodeStats: {
              [messageNodeId]: expect.objectContaining({
                type: NodeStatsType.MessageNodeStats,
                sendRate: 1,
                channelStats: expect.objectContaining({
                  type: ChannelType.Email,
                }) as unknown,
              }) as unknown,
            },
          },
        ]);
      });
    });

    describe("when the journey node has nested segment splits", () => {
      beforeEach(async () => {
        const entryNode: SegmentEntryNode = {
          type: JourneyNodeType.SegmentEntryNode,
          segment: randomUUID(),
          child: "split-node-1",
        };

        const splitNode1: SegmentSplitNode = {
          type: JourneyNodeType.SegmentSplitNode,
          id: "split-node-1",
          variant: {
            type: SegmentSplitVariantType.Boolean,
            segment: randomUUID(),
            falseChild: "message-node-1",
            trueChild: "split-node-2",
          },
        };
        const splitNode2: SegmentSplitNode = {
          id: "split-node-2",
          type: JourneyNodeType.SegmentSplitNode,
          variant: {
            type: SegmentSplitVariantType.Boolean,
            segment: randomUUID(),
            falseChild: "message-node-1",
            trueChild: "message-node-2",
          },
        };
        const messageNode1: MessageNode = {
          id: "message-node-1",
          type: JourneyNodeType.MessageNode,
          child: JourneyNodeType.ExitNode,
          variant: {
            type: ChannelType.Email,
            templateId: randomUUID(),
          },
        };
        const messageNode2: MessageNode = {
          id: "message-node-2",
          type: JourneyNodeType.MessageNode,
          child: "message-node-1",
          variant: {
            type: ChannelType.Email,
            templateId: randomUUID(),
          },
        };

        const journeyDefinition: JourneyDefinition = {
          entryNode,
          nodes: [splitNode1, splitNode2, messageNode1, messageNode2],
          exitNode: {
            type: JourneyNodeType.ExitNode,
          },
        };
        journeyId = randomUUID();
        await db()
          .insert(dbJourney)
          .values({
            workspaceId,
            id: journeyId,
            definition: journeyDefinition,
            name: randomUUID(),
            status: JourneyResourceStatusEnum.Running,
            updatedAt: new Date(),
          } satisfies PgInsertValue<typeof dbJourney>);

        const journeyStartedAt = Date.now();

        await Promise.all([
          ...R.times(3, (i) =>
            recordNodeProcessed({
              journeyStartedAt,
              journeyId,
              node: entryNode,
              workspaceId,
              userId: `user-${i}`,
            }),
          ),
          ...R.times(3, (i) =>
            recordNodeProcessed({
              journeyStartedAt,
              journeyId,
              node: splitNode1,
              workspaceId,
              userId: `user-${i}`,
            }),
          ),
          ...R.times(3, (i) =>
            recordNodeProcessed({
              journeyStartedAt,
              journeyId,
              node: messageNode1,
              workspaceId,
              userId: `user-${i}`,
            }),
          ),
          ...R.times(2, (i) =>
            recordNodeProcessed({
              journeyStartedAt,
              journeyId,
              node: splitNode2,
              workspaceId,
              userId: `user-${i + 1}`,
            }),
          ),
          recordNodeProcessed({
            journeyStartedAt,
            journeyId,
            node: messageNode2,
            workspaceId,
            userId: `user-2`,
          }),
        ]);
      });

      it("calculates the correct journey percentages", async () => {
        const stats = await getJourneysStats({
          workspaceId,
          journeyIds: [journeyId],
        });

        if (
          stats[0]?.nodeStats["split-node-1"]?.type !==
          NodeStatsType.SegmentSplitNodeStats
        ) {
          throw new Error(
            "Expected split-node-1 to be a SegmentSplitNodeStats",
          );
        }
        expect(
          Math.floor(
            stats[0]?.nodeStats["split-node-1"]?.proportions.falseChildEdge ??
              0,
          ),
          "one third of the users should have gone down the false edge",
        ).toEqual(33);

        if (
          stats[0]?.nodeStats["split-node-2"]?.type !==
          NodeStatsType.SegmentSplitNodeStats
        ) {
          throw new Error(
            "Expected split-node-2 to be a SegmentSplitNodeStats",
          );
        }
        expect(
          stats[0]?.nodeStats["split-node-2"]?.proportions.falseChildEdge,
        ).toEqual(50);

        if (
          stats[0]?.nodeStats["message-node-1"]?.type !==
          NodeStatsType.MessageNodeStats
        ) {
          throw new Error("Expected message-node-1 to be a MessageNodeStats");
        }

        expect(
          stats[0]?.nodeStats["message-node-1"].proportions.childEdge,
        ).toEqual(100);

        if (
          stats[0]?.nodeStats["message-node-2"]?.type !==
          NodeStatsType.MessageNodeStats
        ) {
          throw new Error("Expected message-node-2 to be a MessageNodeStats");
        }

        expect(
          stats[0]?.nodeStats["message-node-2"].proportions.childEdge,
        ).toEqual(100);
      });
    });
  });
  // TODO: add tests for upsertJourney
  describe("upsertJourney", () => {
    describe("when a journey is created in a second workspace with a re-used id", () => {
      let secondWorkspace: Workspace;

      beforeEach(async () => {
        secondWorkspace = unwrap(
          await createWorkspace({
            name: randomUUID(),
            id: randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        );
      });
      it("returns a unique constraint violation error", async () => {
        const journeyId = randomUUID();
        const result = await upsertJourney({
          workspaceId: workspace.id,
          id: journeyId,
          name: randomUUID(),
          definition: {
            entryNode: {
              type: JourneyNodeType.SegmentEntryNode,
              segment: randomUUID(),
              child: JourneyNodeType.ExitNode,
            },
            exitNode: {
              type: JourneyNodeType.ExitNode,
            },
            nodes: [],
          },
        });
        expect(result.isOk(), "first upsert should succeed").toBe(true);
        const secondResult = await upsertJourney({
          workspaceId: secondWorkspace.id,
          id: journeyId,
          name: randomUUID(),
          definition: {
            entryNode: {
              type: JourneyNodeType.SegmentEntryNode,
              segment: randomUUID(),
              child: JourneyNodeType.ExitNode,
            },
            exitNode: {
              type: JourneyNodeType.ExitNode,
            },
            nodes: [],
          },
        });
        const errorType = secondResult.isErr() && secondResult.error.type;
        expect(
          errorType,
          "second upsert should fail with unique constraint violation",
        ).toEqual(JourneyUpsertValidationErrorType.UniqueConstraintViolation);
      });
    });

    describe.skip("when a journey is started after being paused", () => {
      it("re-triggers user workflows for journeys that can be re-entered and run multiple times", async () => {
        // assert that journey without conditions is not triggered
        // assert that journey with conditions is triggered
        // asert journey status is updated
      });
    });
  });

  describe("getUserJourneys", () => {
    const userId = "user-1";
    const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
    const messageNodeId = "message-node";
    const definition: JourneyDefinition = {
      entryNode: {
        type: JourneyNodeType.SegmentEntryNode,
        segment: randomUUID(),
        child: messageNodeId,
      },
      exitNode: {
        type: JourneyNodeType.ExitNode,
      },
      nodes: [
        {
          id: messageNodeId,
          type: JourneyNodeType.MessageNode,
          variant: {
            type: ChannelType.Email,
            templateId: randomUUID(),
          },
          child: JourneyNodeType.ExitNode,
        },
      ],
    };
    let onboardingJourneyId: string;
    let refillJourneyId: string;
    let otherWorkspaceJourneyId: string;

    beforeEach(async () => {
      onboardingJourneyId = randomUUID();
      refillJourneyId = randomUUID();
      otherWorkspaceJourneyId = randomUUID();
      const otherWorkspace = unwrap(
        await createWorkspace({
          id: randomUUID(),
          name: randomUUID(),
          updatedAt: new Date(),
        }),
      );
      await db()
        .insert(dbJourney)
        .values([
          {
            workspaceId,
            id: onboardingJourneyId,
            definition,
            name: "Onboarding",
            status: JourneyResourceStatusEnum.Running,
          },
          {
            workspaceId,
            id: refillJourneyId,
            definition,
            name: "Refill reminder",
            status: JourneyResourceStatusEnum.Paused,
          },
          {
            workspaceId: otherWorkspace.id,
            id: otherWorkspaceJourneyId,
            definition,
            name: "Other workspace",
            status: JourneyResourceStatusEnum.Running,
          },
        ]);

      const event = ({
        journeyId,
        startedAt,
        type,
        nodeId,
        createdAt,
        user = userId,
        eventKey,
        eventKeyName,
      }: {
        journeyId: string;
        startedAt: number;
        type: JourneyNodeType;
        nodeId: string;
        createdAt: number;
        user?: string;
        eventKey?: string;
        eventKeyName?: string;
      }) => ({
        id: randomUUID(),
        userId: user,
        journeyId,
        type,
        nodeId,
        journeyStartedAt: new Date(startedAt),
        createdAt: new Date(createdAt),
        eventKey,
        eventKeyName,
      });

      await db()
        .insert(dbUserJourneyEvent)
        .values([
          // A completed onboarding run.
          event({
            journeyId: onboardingJourneyId,
            startedAt: t0,
            type: JourneyNodeType.SegmentEntryNode,
            nodeId: JourneyNodeType.SegmentEntryNode,
            createdAt: t0,
          }),
          event({
            journeyId: onboardingJourneyId,
            startedAt: t0,
            type: JourneyNodeType.MessageNode,
            nodeId: messageNodeId,
            createdAt: t0 + 1000,
          }),
          event({
            journeyId: onboardingJourneyId,
            startedAt: t0,
            type: JourneyNodeType.ExitNode,
            nodeId: JourneyNodeType.ExitNode,
            createdAt: t0 + 2000,
          }),
          // A keyed refill run that has only entered.
          event({
            journeyId: refillJourneyId,
            startedAt: t0 + 5000,
            type: JourneyNodeType.EventEntryNode,
            nodeId: JourneyNodeType.EventEntryNode,
            createdAt: t0 + 5000,
            eventKey: "order-1",
            eventKeyName: "orderId",
          }),
          // A second onboarding run, still in progress.
          event({
            journeyId: onboardingJourneyId,
            startedAt: t0 + 10000,
            type: JourneyNodeType.SegmentEntryNode,
            nodeId: JourneyNodeType.SegmentEntryNode,
            createdAt: t0 + 10000,
          }),
          event({
            journeyId: onboardingJourneyId,
            startedAt: t0 + 10000,
            type: JourneyNodeType.MessageNode,
            nodeId: messageNodeId,
            createdAt: t0 + 11000,
          }),
          // Neither of these belongs to the user in this workspace.
          event({
            journeyId: onboardingJourneyId,
            startedAt: t0,
            type: JourneyNodeType.SegmentEntryNode,
            nodeId: JourneyNodeType.SegmentEntryNode,
            createdAt: t0,
            user: "user-2",
          }),
          event({
            journeyId: otherWorkspaceJourneyId,
            startedAt: t0,
            type: JourneyNodeType.SegmentEntryNode,
            nodeId: JourneyNodeType.SegmentEntryNode,
            createdAt: t0,
          }),
        ]);
    });

    it("returns each of the user's runs in the workspace, most recent first", async () => {
      const runs = await getUserJourneys({ workspaceId, userId });
      expect(runs).toEqual([
        {
          journeyId: onboardingJourneyId,
          journeyName: "Onboarding",
          journeyStatus: JourneyResourceStatusEnum.Running,
          startedAt: t0 + 10000,
          eventKey: undefined,
          eventKeyName: undefined,
          exited: false,
          lastNodeId: messageNodeId,
          lastNodeType: JourneyNodeType.MessageNode,
          lastNodeProcessedAt: t0 + 11000,
        },
        {
          journeyId: refillJourneyId,
          journeyName: "Refill reminder",
          journeyStatus: JourneyResourceStatusEnum.Paused,
          startedAt: t0 + 5000,
          eventKey: "order-1",
          eventKeyName: "orderId",
          exited: false,
          lastNodeId: JourneyNodeType.EventEntryNode,
          lastNodeType: JourneyNodeType.EventEntryNode,
          lastNodeProcessedAt: t0 + 5000,
        },
        {
          journeyId: onboardingJourneyId,
          journeyName: "Onboarding",
          journeyStatus: JourneyResourceStatusEnum.Running,
          startedAt: t0,
          eventKey: undefined,
          eventKeyName: undefined,
          exited: true,
          lastNodeId: JourneyNodeType.ExitNode,
          lastNodeType: JourneyNodeType.ExitNode,
          lastNodeProcessedAt: t0 + 2000,
        },
      ]);
    });

    it("returns no runs for a user who has not entered a journey", async () => {
      const runs = await getUserJourneys({ workspaceId, userId: "user-3" });
      expect(runs).toEqual([]);
    });
  });
});
