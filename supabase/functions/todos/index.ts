// Supabase Edge Function: todos
// Powered by @supabase/server SDK for stateless, RLS-scoped JWT validation

import { withSupabase } from "@supabase/server"

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    // RLS-scoped: ctx.supabase is initialized with the user's JWT token.
    // The database enforces that the user only sees their own todos.
    const { data, error } = await ctx.supabase
      .from("todos")
      .select()

    if (error) {
      return Response.json(
        { error: error.message, detail: error.details },
        { status: 500 }
      )
    }

    return Response.json(data)
  }),
}
