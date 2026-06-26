// Supabase Edge Function: projects
// Powered by @supabase/server SDK to manage user-specific persistent project workspaces

import { withSupabase } from "@supabase/server"

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    const { url } = req
    const { pathname } = new URL(url)

    if (pathname.endsWith("/list") || req.method === "GET") {
      const { data, error } = await ctx.supabase
        .from("projects")
        .select("id, name, created_at")
        .order("name", { ascending: true })

      if (error) return Response.json({ error: error.message }, { status: 500 })
      return Response.json(data)
    }

    if (req.method === "POST") {
      const { name } = await req.json()
      if (!name) return Response.json({ error: "Project name is required" }, { status: 400 })
      
      const cleanName = name.replace(/[^a-zA-Z0-9_\-]/g, "")
      if (!cleanName) return Response.json({ error: "Invalid project name" }, { status: 400 })

      const { data, error } = await ctx.supabase
        .from("projects")
        .insert([{ name: cleanName }])
        .select()

      if (error) return Response.json({ error: error.message }, { status: 500 })
      return Response.json({ status: "success", project: data[0] })
    }

    return new Response("Method not allowed", { status: 405 })
  }),
}
