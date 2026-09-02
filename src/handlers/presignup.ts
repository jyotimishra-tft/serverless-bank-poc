import type { PreSignUpTriggerHandler } from 'aws-lambda';
import { getPrisma } from '../lib/db';

/**
 * Cognito calls this BEFORE creating a user. Throwing an error here blocks
 * signup entirely and Cognito returns that error to the client.
 *
 * Expects the frontend to pass, via the Cognito SDK's clientMetadata option
 * on signUp():
 *   { role: 'agent' | 'customer', inviteCode?: '<code>' }
 *
 * - agent    -> MUST supply inviteCode, validated against Organisation.inviteCode
 *               (static per-org code). Blocks signup if missing/invalid.
 * - customer -> no invite code needed at signup. Customers link to a specific
 *               case later via the case-level Invite model (a separate,
 *               post-signup step - not handled here).
 *
 * NOTE: Organisation.inviteCode / Organisation.isBlocked field names are my
 * best guess based on the schema description - check against your actual
 * schema.prisma and adjust if names differ.
 */
export const handler: PreSignUpTriggerHandler = async (event) => {
  const { role, inviteCode } = event.request.clientMetadata ?? {};

  if (!role) {
    throw new Error('Signup requires role in clientMetadata');
  }

  if (role === 'agent') {
    if (!inviteCode) {
      throw new Error('Agent signup requires an organisation inviteCode');
    }

    const prisma = await getPrisma();
    const org = await prisma.organisation.findFirst({
      where: { inviteCode, isBlocked: false },
    });
    if (!org) {
      throw new Error('Invalid or inactive organisation invite code');
    }
  } else if (role !== 'customer') {
    throw new Error(`Unknown role: ${role}`);
  }
  // role === 'customer': no gate, signup proceeds freely.

  // Auto-confirm + auto-verify email - skips Cognito's separate email
  // verification step. Remove these two lines if you want that step kept.
  event.response.autoConfirmUser = true;
  event.response.autoVerifyEmail = true;

  return event;
};