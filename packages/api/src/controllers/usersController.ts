import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { getUserJourneys } from "backend-lib/src/journeys";
import { getUserSubscriptions } from "backend-lib/src/subscriptionGroups";
import {
  BadRequestResponse,
  DeleteUsersRequest,
  EmptyResponse,
  GetUserJourneysRequest,
  GetUserJourneysResponse,
  GetUsersCountResponse,
  GetUsersRequest,
  GetUsersResponse,
  GetUserSubscriptionsRequest,
  GetUserSubscriptionsResponse,
} from "backend-lib/src/types";
import { deleteUsers, getUsers, getUsersCount } from "backend-lib/src/users";
import { FastifyInstance } from "fastify";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function usersController(fastify: FastifyInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/",
    {
      schema: {
        description: "Get list of users",
        tags: ["Users"],
        body: GetUsersRequest,
        response: {
          200: GetUsersResponse,
          400: BadRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const result = await getUsers(request.body);
      if (result.isErr()) {
        return reply.status(400).send({
          message: result.error.message,
        });
      }
      const { users, nextCursor, previousCursor, userCount } = result.value;
      return reply.status(200).send({
        users,
        nextCursor,
        previousCursor,
        userCount,
      });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().post(
    "/count",
    {
      schema: {
        description: "Get count of users",
        tags: ["Users"],
        body: GetUsersRequest,
        response: {
          200: GetUsersCountResponse,
          400: BadRequestResponse,
        },
      },
    },
    async (request, reply) => {
      const result = await getUsersCount(request.body);
      if (result.isErr()) {
        return reply.status(400).send({
          message: result.error.message,
        });
      }
      return reply.status(200).send(result.value);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/subscriptions",
    {
      schema: {
        description: "Get subscriptions for a user",
        tags: ["Users"],
        querystring: GetUserSubscriptionsRequest,
        response: {
          200: GetUserSubscriptionsResponse,
        },
      },
    },

    async (request, reply) => {
      const result = await getUserSubscriptions({
        workspaceId: request.query.workspaceId,
        userId: request.query.userId,
      });
      return reply.status(200).send({
        workspaceId: request.query.workspaceId,
        userId: request.query.userId,
        subscriptionGroups: result,
      });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/journeys",
    {
      schema: {
        description:
          "Get the journeys a user has entered, one entry per run, most recent first. A run with exited set to false is still in progress.",
        tags: ["Users"],
        querystring: GetUserJourneysRequest,
        response: {
          200: GetUserJourneysResponse,
        },
      },
    },
    async (request, reply) => {
      const runs = await getUserJourneys(request.query);
      return reply.status(200).send({
        workspaceId: request.query.workspaceId,
        userId: request.query.userId,
        runs,
      });
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/",
    {
      schema: {
        description:
          "Delete events, and computed properties and segments for specific users.",
        tags: ["Users"],
        body: DeleteUsersRequest,
        response: {
          204: EmptyResponse,
        },
      },
    },
    async (request, reply) => {
      await deleteUsers(request.body);
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/v2",
    {
      schema: {
        description:
          "Delete events, and computed properties and segments for specific users.",
        tags: ["Users"],
        querystring: DeleteUsersRequest,
        response: {
          204: EmptyResponse,
        },
      },
    },
    async (request, reply) => {
      await deleteUsers(request.query);
      return reply.status(204).send();
    },
  );
}
