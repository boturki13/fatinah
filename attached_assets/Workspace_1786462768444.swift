import ProjectDescription

let projectName = Environment.projectName.getString(default: "MedianIOS")

let workspace = Workspace(
    name: projectName,
    projects: ["."],
    generationOptions: .options(
        derivedDataPath: .custom("build")
    )
)
