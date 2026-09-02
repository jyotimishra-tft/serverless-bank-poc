import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { getPrisma } from '../lib/db';

/**
 * Cognito calls this AFTER a user is confirmed (immediately, in our case,
 * since PreSignUp sets autoConfirmUser = true). This is where the actual
 * app-level Customer/Agent row gets created - PreSignUp only validates.
 *
 * event.request.userAttributes.sub is Cognito's permanent user ID - this
 * becomes cognitoSub on the DB row, per the "no password hashes, cognitoSub
 * instead" decision.
 *
 * NOTE: I'm guessing at exact field names (Agent.organisationId,
 * Customer.commPrefEmail default, etc.) based on what's been discussed -
 * check against your actual schema.prisma and adjust as needed.
 */
export const handler: PostConfirmationTriggerHandler = async (event) => {
  const { role, inviteCode, firstName, lastName } = event.request.clientMetadata ?? {};
  const sub = event.request.userAttributes.sub;
  const email = event.request.userAttributes.email;

  if (!role || !sub || !email || !firstName) {
    // Don't throw here - the Cognito user already exists at this point,
    // throwing won't undo that, it'll just break the signup response with
    // a confusing error. Log and let a manual/reconciliation step fix it.
    console.error('PostConfirmation missing role/sub/email/firstName', {
      role,
      sub,
      email,
      firstName,
    });
    return event;
  }

  const prisma = await getPrisma();

  if (role === 'customer') {
    // Per schema design: a bank-imported customer row may already exist
    // (same email, no cognitoSub yet). Attach this login to it rather than
    // creating a duplicate. Only create fresh if no matching row exists.
    await prisma.customer.upsert({
      where: { email },
      update: { cognitoSub: sub },
      create: {
        cognitoSub: sub,
        email,
        firstName,
        ...(lastName ? { lastName } : {}),
      },
    });
  } else if (role === 'agent') {
    if (!inviteCode) {
      console.error('PostConfirmation: agent with no inviteCode', { sub, email });
      return event;
    }

    const org = await prisma.organisation.findFirst({
      where: { inviteCode, isBlocked: false },
    });

    if (!org) {
      // Shouldn't happen - PreSignUp already validated this exact code -
      // but the org could theoretically have been blocked in the gap
      // between the two trigger calls. Log for manual follow-up.
      console.error('PostConfirmation: org no longer valid', { inviteCode, sub, email });
      return event;
    }

    await prisma.agent.create({
      data: {
        cognitoSub: sub,
        email,
        name: lastName ? `${firstName} ${lastName}` : firstName,
        organisationId: org.id,
      },
    });
  }

  return event;
};