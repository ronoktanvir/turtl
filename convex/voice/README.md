# Voice: talking with turtl about a case

Brief section 5.11. The owner, hands busy, talks with turtl about one case and hears what it is doing or stuck on. Voice is a way into the existing case chat (Investigate further, and the question line on Fix enacting), not a second conversation: every spoken question and every reply is a row in `fixChatMessages`, so it shows as text in the same thread.

## One turn

`api.voice.turn.talk({ caseId, audio, mimeType, durationMs })` is a Convex action.

1. Refuses, with a plain message and without calling anything, when `VOICE_ENABLED` is not `true`, when `OPENAI_API_KEY` is missing, when the clip is longer than 30 seconds or 1 MB, or when the audio type is not one turtl reads.
2. `internal.voice.turn.begin` counts the case's turns in the last 10 minutes and refuses past 20 (the per-case rate limit), then records a `voiceTurns` row.
3. Transcribes the clip with OpenAI speech to text (`gpt-4o-mini-transcribe`, override with `VOICE_TRANSCRIBE_MODEL`). The audio arrives as bytes in the action's arguments and is never stored: not in file storage, not in a table. The app deletes its recording file as soon as it has read it.
4. Decides what to do with the words:
   - A spoken owner decision (approve, decline, merge, stop) is answered with where its button is, from `COMMAND_REPLIES` in `rules.ts`. No model is asked and no decision function is reachable from this module. Approval stays a tap on Approve behind the owner passcode.
   - "That's all" or "stop listening" ends the hands-free conversation.
   - Anything else goes to `api.fixes.investigate`, the same grounded case chat that typed questions use.
5. Speaks the reply with OpenAI text to speech (`gpt-4o-mini-tts`, override with `VOICE_SPEECH_MODEL`) and returns the MP3 bytes. Long replies are spoken in whole sentences up to 1,200 characters, then "The rest is on screen." A failed speech call returns the reply as text and says it could not be spoken.

Every model call writes an `agentRuns` row through `internal.voice.runs.record`: `voice_transcription`, `case_chat_answer` (written by `fixes.investigate`, so typed questions get one too) and `voice_speech`. These rows belong to a case and not to a workflow step, so `stepId` and `stepAttemptId` are optional on `agentRuns` now. They show in the case's Logs as "Agent run · voice_…".

`api.voice.turn.status({ caseId })` tells the app whether voice can run here and, if not, why.

## "What are you stuck on?"

`progress.ts` builds `work` for the case chat's context: a one-line `now` ("Gather context is running (attempt 2 of 3, for 30 seconds), waiting for…"), the steps running or waiting with what each waits for, the steps that cannot start yet and what blocks them, and the last error with its step, attempt and age. `fixes.chatContext` includes it and the chat prompt tells the model to answer from it, so typed and spoken questions get the same answer.

## The app

`components/voice/useTalkSession.ts` runs a turn-based, hands-free session with `expo-audio`: listen, end the turn when the owner pauses for 1.4 seconds after speaking (from the recorder's level meter, `components/voice/ear.ts`) or at 30 seconds, send, speak the reply, listen again, until the owner taps End or says "that's all". After 30 seconds with no speech it stops listening and says so. Send ends a turn early and Skip stops the spoken reply; both help in a loud room, where the pause detection cannot hear silence. The talk control sits in `AskBar`; while a session runs it replaces the text field with the state, a level ring, Send or Skip, and End. Every control has a screen-reader label and state changes are announced.

`data/live/voice.ts` calls the backend; `data/example/voice.ts` says voice needs turtl's backend.

## Deploy

- `npx convex env set VOICE_ENABLED true` turns voice on. `OPENAI_API_KEY` is already required by the case chat.
- `expo-audio` is a new native module, so the iOS app needs a new native build. The microphone permission text is in `app.config.ts`.
