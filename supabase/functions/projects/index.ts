// Supabase Edge Function: projects
// Powered by @supabase/server SDK to manage user-specific persistent project workspaces

import { withSupabase } from "@supabase/server"

export default {
  fetch: withSupabase({ auth: ["user", "secret"] }, async (req, ctx) => {
    const { url } = req
    const { pathname } = new URL(url)
    
    // Auth mode detection: "user" (JWT authenticated) or "secret" (backend system / admin key)
    const isServiceRole = ctx.authMode === "secret"

    if (pathname.endsWith("/list") || req.method === "GET") {
      if (isServiceRole) {
        // Bypasses RLS to inspect all workspace folders for audit or orchestration
        const { data, error } = await ctx.supabaseAdmin
          .from("projects")
          .select("*")
          .order("name", { ascending: true })
          
        if (error) return Response.json({ error: error.message }, { status: 500 })
        return Response.json(data)
      } else {
        // RLS-scoped: returns only projects belonging to this authenticated user (auth.uid() = user_id)
        const { data, error } = await ctx.supabase
          .from("projects")
          .select("id, name, created_at")
          .order("name", { ascending: true })
          
        if (error) return Response.json({ error: error.message }, { status: 500 })
        return Response.json(data)
      }
    }

    if (req.method === "POST") {
      const { name } = await req.json()
      if (!name) return Response.json({ error: "Project name is required" }, { status: 400 })
      
      const cleanName = name.replace(/[^a-zA-Z0-9_\-]/g, "")
      if (!cleanName) return Response.json({ error: "Invalid project name" }, { status: 400 })

      if (isServiceRole) {
        // Bypasses RLS to insert or sync from backend
        const { data, error } = await ctx.supabaseAdmin
          .from("projects")
          .insert([{ name: cleanName }])
          .select()
          
        if (error) return Response.json({ error: error.message }, { status: 500 })
        return Response.json({ status: "success", project: data[0] })
      } else {
        // RLS-scoped insert (automatically associates user_id using default auth.uid())
        const { data, error } = await ctx.supabase
          .from("projects")
          .insert([{ name: cleanName }])
          .select()
          
        if (error) return Response.json({ error: error.message }, { status: 500 })
        return Response.json({ status: "success", project: data[0] })
      }
    }

    return new Response("Method not allowed", { status: 405 })
  }),
}
